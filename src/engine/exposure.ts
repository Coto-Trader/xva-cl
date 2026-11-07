/**
 * Fase 4 — Motor de Exposición: Netting Set, Colateral CSA (MPOR, Threshold, MTA, Segregated IM),
 * EE(t), ENE(t), PFE 99%(t), EPE, EEPE y Settlement Spike (Physical vs NDS).
 *
 * Referencias:
 * - Jon Gregory, "The xVA Challenge" (3rd ed., 2015):
 *   - Cap. 6 (Netting, Close-out y aplicación de CSA)
 *   - Cap. 7 (Medidas de exposición: EE, ENE, PFE, EPE, Effective EPE)
 *   - Cap. 11 (Initial Margin segregado, Threshold, MTA y Margin Period of Risk)
 */

import type { AnyTrade, CSA, MarketEnv, MonteCarloConfig } from '../domain/types';
import type { CurveSet } from './curves';
import { priceTradePathwiseUF } from './pricing';
import { type SimulationGrid, generateMonteCarloScenarios } from './scenario';

export interface ExposureProfileResult {
  /** Grilla temporal en años [T] */
  times: number[];
  /** Expected Exposure con CSA aplicado: EE(t) = E[max(V_coll(t), 0)] >= 0 */
  ee: number[];
  /** Expected Negative Exposure con CSA aplicado: ENE(t) = E[max(-V_coll(t), 0)] >= 0 */
  ene: number[];
  /** Potential Future Exposure al cuantil pfeQuantile (default 0.99) con CSA */
  pfe: number[];
  /** Expected Exposure sin colateral (uncollateralized): E[max(V_NS(t), 0)] */
  eeUncollateralized: number[];
  /** Expected Negative Exposure sin colateral: E[max(-V_NS(t), 0)] */
  eneUncollateralized: number[];
  /** PFE 99% sin colateral */
  pfeUncollateralized: number[];
  /** Colateral promedio retenido E[C(t)] en cada fecha */
  expectedCollateral: number[];
  /** Effective Expected Exposure: EEE(t_k) = max(EEE(t_{k-1}), EE(t_k)) */
  eee: number[];
  /** Expected Positive Exposure (promedio temporal ponderado de EE(t) en [0, T]) */
  epe: number;
  /** Effective EPE (promedio temporal de EEE(t) en el primer año min(T, 1Y), Basel III / Gregory Cap. 7) */
  eepe: number;
  /** EPE sin colateral para medir la reducción porcentual por CSA */
  epeUncollateralized: number;
}

export interface CollateralSpikeReport {
  physical_pfe_99: number;
  nds_pfe_99: number;
  spike_ratio: number;
  excess_exposure_clp: number;
}

/**
 * Encuentra el índice de grilla t_lag <= t - mporYears para evaluar el colateral
 * con rezago de Margin Period of Risk (Gregory Cap. 11).
 */
function findLookbackIndex(times: readonly number[], currentIdx: number, mporYears: number): number {
  if (mporYears <= 0) {
    return currentIdx;
  }
  const targetTime = times[currentIdx] - mporYears;
  if (targetTime <= 0) {
    return -1; // Antes de t=0 el colateral entregado aún no se ha actualizado o parte en 0
  }
  let bestIdx = -1;
  for (let j = 0; j <= currentIdx; j++) {
    if (times[j] <= targetTime + 1e-12) {
      bestIdx = j;
    } else {
      break;
    }
  }
  return bestIdx;
}

/**
 * Calcula el colateral de variación C(p, t) bajo un CSA bilateral con MPOR,
 * Threshold y MTA aditivo (Gregory Cap. 6 y Cap. 11).
 *
 * - Para V(t - MPOR) > H_cpty + MTA: C = V(t - MPOR) - H_cpty
 * - Para V(t - MPOR) < -(H_own + MTA): C = V(t - MPOR) + H_own (colateral posteado por el banco, signo negativo)
 * - En la banda [-H_own - MTA, H_cpty + MTA]: C = 0
 * - Nota (Gregory Cap. 11 y Cap. 15): El Initial Margin segregado (`segregatedIM`) NO se
 *   mezcla con el Variation Margin ni genera FBA (no es rehipotecable); reduce la exposición
 *   residual positiva al momento del default: max(V - C_VM - IM_segregated, 0).
 */
export function computeCollateralizedPathExposure(
  times: readonly number[],
  pathMtm: readonly number[],
  csa?: CSA | null,
): {
  collateralizedMtm: number[];
  positiveExposure: number[];
  negativeExposure: number[];
  collateralHeld: number[];
} {
  const n = times.length;
  const collateralizedMtm = new Array<number>(n);
  const positiveExposure = new Array<number>(n);
  const negativeExposure = new Array<number>(n);
  const collateralHeld = new Array<number>(n);

  if (!csa || csa.type === 'NO_CSA') {
    for (let i = 0; i < n; i++) {
      const v = pathMtm[i];
      collateralizedMtm[i] = v;
      positiveExposure[i] = Math.max(v, 0);
      negativeExposure[i] = Math.max(-v, 0);
      collateralHeld[i] = 0;
    }
    return { collateralizedMtm, positiveExposure, negativeExposure, collateralHeld };
  }

  const mporYears = Math.max(0, csa.mporDays) / 365.0;
  const hCpty = Math.max(0, csa.thresholdCpty);
  const hOwn = Math.max(0, csa.thresholdOwn);
  const mta = Math.max(0, csa.mta);
  const rounding = csa.rounding && csa.rounding > 0 ? csa.rounding : 0;
  const imSegregated = csa.segregatedIM ? Math.max(0, csa.initialMargin ?? 0) : 0;
  const isOneWay = csa.type === 'ONE_WAY';

  let prevCollateral = 0;

  for (let i = 0; i < n; i++) {
    const vNow = pathMtm[i];
    const lagIdx = findLookbackIndex(times, i, mporYears);
    const vLag = lagIdx >= 0 ? pathMtm[lagIdx] : 0;

    // Requerimiento teórico de colateral en t - MPOR (Gregory Cap. 6 / Cap. 11)
    let targetCollateral = 0;
    if (vLag > hCpty) {
      targetCollateral = vLag - hCpty;
    } else if (!isOneWay && vLag < -hOwn) {
      targetCollateral = vLag + hOwn; // negativo: colateral entregado por nosotros
    }

    // Regla aditiva de Minimum Transfer Amount (MTA): solo se transfiere si |target - prev| >= MTA
    let cNow = prevCollateral;
    if (Math.abs(targetCollateral - prevCollateral) >= mta) {
      cNow = targetCollateral;
      if (rounding > 0) {
        cNow = Math.round(cNow / rounding) * rounding;
      }
      prevCollateral = cNow;
    }

    const vAfterVm = vNow - cNow;
    collateralHeld[i] = cNow;
    collateralizedMtm[i] = vAfterVm;
    // El IM segregado reduce la exposición positiva al default de la contraparte,
    // pero no incrementa ni reduce nuestro ENE de fondeo (Gregory Cap. 11 / Cap. 15)
    positiveExposure[i] = Math.max(vAfterVm - imSegregated, 0);
    negativeExposure[i] = Math.max(-vAfterVm, 0);
  }

  return { collateralizedMtm, positiveExposure, negativeExposure, collateralHeld };
}

/**
 * Calcula cuantil empírico (ej. 0.99 para PFE 99%) sobre un arreglo de valores.
 */
export function empiricalQuantile(values: readonly number[], quantile = 0.99): number {
  if (values.length === 0) return 0;
  const q = Math.min(1, Math.max(0, quantile));
  const sorted = [...values].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Calcula EE(t), ENE(t), PFE(t), EEE(t), EPE y EEPE a partir de la matriz MTM del Netting Set
 * [numPaths][numTimes] con y sin CSA (Gregory Cap. 6, 7 y 11).
 */
export function computeExposureProfileFromPaths(
  times: readonly number[],
  nettingSetMtmMatrix: readonly (readonly number[])[],
  csa?: CSA | null,
  pfeQuantile = 0.99,
): ExposureProfileResult {
  const numPaths = nettingSetMtmMatrix.length;
  const numTimes = times.length;
  if (numPaths === 0 || numTimes === 0) {
    throw new Error('nettingSetMtmMatrix and times must be non-empty.');
  }

  const ee = new Array<number>(numTimes).fill(0);
  const ene = new Array<number>(numTimes).fill(0);
  const pfe = new Array<number>(numTimes).fill(0);
  const eeUncollateralized = new Array<number>(numTimes).fill(0);
  const eneUncollateralized = new Array<number>(numTimes).fill(0);
  const pfeUncollateralized = new Array<number>(numTimes).fill(0);
  const expectedCollateral = new Array<number>(numTimes).fill(0);

  // Acumuladores por columna temporal para PFE
  const collPosByTime: number[][] = Array.from({ length: numTimes }, () => new Array<number>(numPaths));
  const uncollPosByTime: number[][] = Array.from({ length: numTimes }, () => new Array<number>(numPaths));

  for (let p = 0; p < numPaths; p++) {
    const pathMtm = nettingSetMtmMatrix[p];
    const coll = computeCollateralizedPathExposure(times, pathMtm, csa);

    for (let i = 0; i < numTimes; i++) {
      const vRaw = pathMtm[i];
      const posRaw = Math.max(vRaw, 0);
      const negRaw = Math.max(-vRaw, 0);

      eeUncollateralized[i] += posRaw / numPaths;
      eneUncollateralized[i] += negRaw / numPaths;
      uncollPosByTime[i][p] = posRaw;

      ee[i] += coll.positiveExposure[i] / numPaths;
      ene[i] += coll.negativeExposure[i] / numPaths;
      expectedCollateral[i] += coll.collateralHeld[i] / numPaths;
      collPosByTime[i][p] = coll.positiveExposure[i];
    }
  }

  for (let i = 0; i < numTimes; i++) {
    pfe[i] = empiricalQuantile(collPosByTime[i], pfeQuantile);
    pfeUncollateralized[i] = empiricalQuantile(uncollPosByTime[i], pfeQuantile);
  }

  // Effective Expected Exposure EEE(t_k) = max(EEE(t_{k-1}), EE(t_k)) (Gregory Cap. 7)
  const eee = new Array<number>(numTimes).fill(0);
  let runningMax = 0;
  for (let i = 0; i < numTimes; i++) {
    runningMax = Math.max(runningMax, ee[i]);
    eee[i] = runningMax;
  }

  // Promedios temporales ponderados por dt: EPE en [0, T] y EEPE en [0, min(1.0, T)]
  let totalTime = 0;
  let weightedEe = 0;
  let weightedEeUncoll = 0;
  let totalTime1Y = 0;
  let weightedEee1Y = 0;

  for (let i = 0; i < numTimes; i++) {
    const tPrev = i === 0 ? 0 : times[i - 1];
    const dt = Math.max(0, times[i] - tPrev);
    totalTime += dt;
    weightedEe += ee[i] * dt;
    weightedEeUncoll += eeUncollateralized[i] * dt;

    if (times[i] <= 1.0 + 1e-9 || i === 0) {
      totalTime1Y += dt;
      weightedEee1Y += eee[i] * dt;
    }
  }

  const epe = totalTime > 0 ? weightedEe / totalTime : 0;
  const epeUncollateralized = totalTime > 0 ? weightedEeUncoll / totalTime : 0;
  const eepe = totalTime1Y > 0 ? weightedEee1Y / totalTime1Y : eee[0] ?? 0;

  return {
    times: [...times],
    ee,
    ene,
    pfe,
    eeUncollateralized,
    eneUncollateralized,
    pfeUncollateralized,
    expectedCollateral,
    eee,
    epe,
    eepe,
    epeUncollateralized,
  };
}

/**
 * Agrega el MTM por trayectoria (en UF) de todos los trades en el Netting Set:
 * V_NS(p, t) = sum_{trade in NS} V_trade(p, t) (Gregory Cap. 6).
 */
export function aggregateNettingSetMtm(
  trades: readonly AnyTrade[],
  market: MarketEnv,
  curves: CurveSet,
  grid: SimulationGrid,
): number[][] {
  const numPaths = grid.numPaths;
  const numTimes = grid.bucketTimes.length;
  const totalMtm: number[][] = Array.from({ length: numPaths }, () =>
    new Array<number>(numTimes).fill(0),
  );

  for (const trade of trades) {
    for (let p = 0; p < numPaths; p++) {
      const pathPoints = grid.paths[p];
      for (let i = 0; i < numTimes; i++) {
        totalMtm[p][i] += priceTradePathwiseUF(trade, market, curves, pathPoints[i]);
      }
    }
  }

  return totalMtm;
}

/**
 * Ejecuta la simulación Monte Carlo completa del Netting Set y retorna el perfil de exposición
 * junto con la grilla simulada y la matriz MTM agregada.
 */
export function simulateNettingSetExposure(
  trades: readonly AnyTrade[],
  market: MarketEnv,
  curves: CurveSet,
  mc: MonteCarloConfig,
  csa?: CSA | null,
  pfeQuantile = 0.99,
): {
  grid: SimulationGrid;
  nettingSetMtm: number[][];
  profile: ExposureProfileResult;
} {
  const maxMaturity = trades.reduce((acc, t) => Math.max(acc, t.maturityYears), 1.0);
  const grid = generateMonteCarloScenarios(market, curves, mc, maxMaturity);
  const nettingSetMtm = aggregateNettingSetMtm(trades, market, curves, grid);
  const profile = computeExposureProfileFromPaths(grid.bucketTimes, nettingSetMtm, csa, pfeQuantile);
  return { grid, nettingSetMtm, profile };
}

/**
 * Perfil analítico de referencia para un CCS UF/CLP con amortización/pull-to-par
 * (reproduce `build_expected_exposure_profile` de `xva/exposure.py` y `demo.py`).
 *
 * // SUPUESTO (no en Gregory): Factor de amortización lineal `(1 - 0.35 * (t / t_max))`
 * utilizado en el motor de referencia `demo.py` para aproximar el efecto pull-to-par
 * de un Cross-Currency Swap UF/CLP sin Monte Carlo.
 */
export function buildExpectedExposureProfile(
  times: readonly number[],
  spotUfClp: number,
  notionalUf: number,
  volAnnual: number,
): number[] {
  if (times.length === 0) return [];
  const tMax = Math.max(...times);
  return times.map((t) => {
    if (t < 0) {
      throw new Error('All exposure times must be non-negative.');
    }
    const diffusion = Math.sqrt(t);
    const amortization = tMax > 0 ? Math.max(0.15, 1.0 - 0.35 * (t / tMax)) : 1.0;
    return notionalUf * spotUfClp * volAnnual * diffusion * amortization;
  });
}

/**
 * Perfil ENE proporcional al EE para el benchmark determinístico de `demo.py`
 * (`expected_negative_exposure_from_ee` en `xva/exposure.py`).
 *
 * // SUPUESTO (no en Gregory): Escalamiento fijo `ENE(t) = ratio * EE(t)` para el benchmark analítico.
 */
export function expectedNegativeExposureFromEe(ee: readonly number[], ratio = 0.55): number[] {
  if (ratio < 0) {
    throw new Error('ratio must be non-negative.');
  }
  return ee.map((v) => v * ratio);
}

/**
 * PFE 99% de liquidación por Entrega Física (Physical Delivery, riesgo Herstatt sobre nocional completo,
 * Gregory Cap. 6 / `physical_delivery_pfe` en `xva/exposure.py`).
 */
export function physicalDeliveryPfe(
  notionalClp: number,
  spotVolAnnual: number,
  settlementDays = 2,
  confidenceZ = 2.3263478740408408,
): number {
  if (notionalClp <= 0 || spotVolAnnual <= 0 || settlementDays <= 0) {
    throw new Error('Inputs must be strictly positive.');
  }
  const tau = settlementDays / 252.0;
  const move = confidenceZ * spotVolAnnual * Math.sqrt(tau);
  return notionalClp * (1.0 + move);
}

/**
 * PFE 99% bajo liquidación por compensación Non-Deliverable Swap (NDS, solo diferencial de fixing,
 * `nds_pfe` en `xva/exposure.py`).
 */
export function ndsPfe(
  notionalClp: number,
  fixingVolAnnual: number,
  fixingGapDays = 1,
  confidenceZ = 2.3263478740408408,
): number {
  if (notionalClp <= 0 || fixingVolAnnual <= 0 || fixingGapDays <= 0) {
    throw new Error('Inputs must be strictly positive.');
  }
  const tau = fixingGapDays / 252.0;
  return notionalClp * confidenceZ * fixingVolAnnual * Math.sqrt(tau);
}

/**
 * Compara el spike de exposición en fecha de liquidación entre Physical Delivery y NDS
 * (`collateral_spike_report` en `xva/exposure.py`).
 */
export function collateralSpikeReport(
  notionalClp: number,
  spotVolAnnual = 0.12,
): CollateralSpikeReport {
  const physical = physicalDeliveryPfe(notionalClp, spotVolAnnual, 2);
  const nds = ndsPfe(notionalClp, spotVolAnnual, 1);
  const ratio = physical / Math.max(nds, 1e-12);
  return {
    physical_pfe_99: physical,
    nds_pfe_99: nds,
    spike_ratio: ratio,
    excess_exposure_clp: physical - nds,
  };
}
