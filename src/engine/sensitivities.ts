/**
 * Fase 7 — Motor de Sensibilidades XVA (DV01 por Tenor, CS01, Vega, FX Delta, Theta)
 * y Grilla Pre-Computada QuickSens 3D.
 *
 * Referencias:
 * - Jon Gregory, "The xVA Challenge" (3rd ed., 2015), Cap. 18 (Managing xVA: Sensibilidades y Greeks)
 * - Reproduce `sensitivities/aad.py` (gradientes exactos y FD por tenor) y
 *   `sensitivities/quicksens_grid.py` (interpolación trilineal 3D en sub-milisegundo).
 */

import { bootstrapHazardRate, marginalDefaultProbability, survivalProbability } from './credit';
import type { CurveSet } from './curves';
import { buildAnalyticalCCSExposureProfile, priceFixedCashflowsLinear } from './pricing';
import { computeXvaSummary } from './xva';

export interface QuickSensAxes {
  uf_shift_bps: number[];
  clp_shift_bps: number[];
  fx_spot_pct: number[];
}

export interface QuickSensGrid {
  axes: QuickSensAxes;
  /** Tensor 3D [i_uf][j_clp][k_fx] con el métrico precomputado (ej. net_xva o CVA) */
  values: number[][][];
}

export interface XvaGreeks {
  /** Sensibilidad de CVA a +1 bp en el spread CDS de la contraparte (Gregory Cap. 18) */
  cs01: number;
  /** Sensibilidad de DVA a +1 bp en nuestro propio spread CDS */
  ownCs01: number;
  /** Sensibilidad de CVA a +1% (+100 bps abs) de volatilidad anualizada UF/CLP (Gregory Cap. 18) */
  vega: number;
  /** Sensibilidad de CVA a +1% en el tipo de cambio spot UF/CLP */
  fxDelta: number;
  /** Sensibilidad de XVA a +1 bp paralelo en la curva de descuento UF */
  rateDv01Parallel: number;
  /** DV01 por nodo de tenor (en unidades de moneda por +1 bp en el nodo k) */
  dv01ByTenor: Record<string, number>;
  /** Decay temporal (Theta a 1 mes = 1/12 año) sobre el CVA */
  theta1M: number;
}

/**
 * Calcula el gradiente analítico exacto dPV / dz_k para un vector de flujos descontados
 * con interpolación lineal por tramos sobre `zeroRates` (reproduce `compute_deltas_aad`
 * de `sensitivities/aad.py` con precisión de máquina).
 */
export function computeDeltasAnalytical(
  zeroRates: readonly number[],
  tenors: readonly number[],
  cashflowTimes: readonly number[],
  cashflowAmounts: readonly number[],
): number[] {
  if (zeroRates.length !== tenors.length) {
    throw new Error(`zeroRates.length (${zeroRates.length}) != tenors.length (${tenors.length})`);
  }
  if (cashflowTimes.length !== cashflowAmounts.length) {
    throw new Error(
      `cashflowTimes.length (${cashflowTimes.length}) != cashflowAmounts.length (${cashflowAmounts.length})`,
    );
  }

  const n = tenors.length;
  const grads = new Array<number>(n).fill(0);
  const minT = tenors[0];
  const maxT = tenors[n - 1];

  for (let m = 0; m < cashflowTimes.length; m++) {
    const t = cashflowTimes[m];
    const amt = cashflowAmounts[m];
    const tClipped = Math.min(Math.max(t, minT), maxT);

    if (tClipped <= minT) {
      const z = zeroRates[0];
      const dPvDz = -t * amt * Math.exp(-z * t);
      grads[0] += dPvDz;
    } else if (tClipped >= maxT) {
      const z = zeroRates[n - 1];
      const dPvDz = -t * amt * Math.exp(-z * t);
      grads[n - 1] += dPvDz;
    } else {
      for (let k = 0; k < n - 1; k++) {
        if (tClipped >= tenors[k] && tClipped <= tenors[k + 1]) {
          const w = (tClipped - tenors[k]) / (tenors[k + 1] - tenors[k]);
          const z = zeroRates[k] + w * (zeroRates[k + 1] - zeroRates[k]);
          const dPvDz = -t * amt * Math.exp(-z * t);
          grads[k] += dPvDz * (1.0 - w);
          grads[k + 1] += dPvDz * w;
          break;
        }
      }
    }
  }

  return grads;
}

/**
 * Calcula dPV / dz_k por diferencias finitas centradas (`compute_deltas_fd` en `sensitivities/aad.py`).
 */
export function computeDeltasFiniteDiff(
  zeroRates: readonly number[],
  tenors: readonly number[],
  cashflowTimes: readonly number[],
  cashflowAmounts: readonly number[],
  bump = 1e-5,
): number[] {
  const n = zeroRates.length;
  const grads = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const up = [...zeroRates];
    const dn = [...zeroRates];
    up[i] += bump;
    dn[i] -= bump;
    const pvUp = priceFixedCashflowsLinear(up, tenors, cashflowTimes, cashflowAmounts);
    const pvDn = priceFixedCashflowsLinear(dn, tenors, cashflowTimes, cashflowAmounts);
    grads[i] = (pvUp - pvDn) / (2.0 * bump);
  }

  return grads;
}

/**
 * Retorna el mapa `{ [tenor]: dv01 }` donde `dv01 = (dPV / dz_k) * 1e-4`
 * (`compute_dv01_aad` en `sensitivities/aad.py`).
 */
export function computeDv01ByTenor(
  zeroRates: readonly number[],
  tenors: readonly number[],
  cashflowTimes: readonly number[],
  cashflowAmounts: readonly number[],
): Record<string, number> {
  const grads = computeDeltasAnalytical(zeroRates, tenors, cashflowTimes, cashflowAmounts);
  const out: Record<string, number> = {};
  for (let i = 0; i < tenors.length; i++) {
    out[tenors[i].toFixed(2)] = grads[i] * 1e-4;
  }
  return out;
}

/**
 * Ejes por defecto de la grilla QuickSens 3D (`default_axes` en `sensitivities/quicksens_grid.py`).
 */
export function defaultQuickSensAxes(): QuickSensAxes {
  return {
    uf_shift_bps: [-150.0, -100.0, -50.0, 0.0, 50.0, 100.0, 150.0],
    clp_shift_bps: [-200.0, -100.0, -50.0, 0.0, 50.0, 100.0, 200.0],
    fx_spot_pct: [-0.10, -0.05, -0.02, 0.0, 0.02, 0.05, 0.10],
  };
}

/**
 * Construye la grilla 3D pre-computada evaluando `pricerFn(ufBps, clpBps, fxPct)`
 * en el producto cartesiano de los tres ejes (`build_quicksens_grid` en `quicksens_grid.py`).
 */
export function buildQuickSensGrid(
  pricerFn: (ufShiftBps: number, clpShiftBps: number, fxSpotPct: number) => number,
  axes: QuickSensAxes = defaultQuickSensAxes(),
): QuickSensGrid {
  const nUf = axes.uf_shift_bps.length;
  const nClp = axes.clp_shift_bps.length;
  const nFx = axes.fx_spot_pct.length;

  const values: number[][][] = Array.from({ length: nUf }, (_, i) =>
    Array.from({ length: nClp }, (__, j) =>
      Array.from({ length: nFx }, (___, k) =>
        pricerFn(axes.uf_shift_bps[i], axes.clp_shift_bps[j], axes.fx_spot_pct[k]),
      ),
    ),
  );

  return { axes, values };
}

function locateBracket(axis: readonly number[], x: number): { idx0: number; idx1: number; w: number } {
  const n = axis.length;
  if (n === 1 || x <= axis[0]) {
    return { idx0: 0, idx1: 0, w: 0 };
  }
  if (x >= axis[n - 1]) {
    return { idx0: n - 1, idx1: n - 1, w: 0 };
  }
  for (let i = 0; i < n - 1; i++) {
    if (x >= axis[i] && x <= axis[i + 1]) {
      const span = axis[i + 1] - axis[i];
      const w = span > 0 ? (x - axis[i]) / span : 0;
      return { idx0: i, idx1: i + 1, w };
    }
  }
  return { idx0: n - 1, idx1: n - 1, w: 0 };
}

/**
 * Interpolación trilineal exacta con clamping en bordes sobre la grilla QuickSens 3D
 * (`QuickSensGrid.interpolate` en `sensitivities/quicksens_grid.py`).
 */
export function interpolateQuickSens(
  grid: QuickSensGrid,
  ufShiftBps: number,
  clpShiftBps: number,
  fxSpotPct: number,
): number {
  const bUf = locateBracket(grid.axes.uf_shift_bps, ufShiftBps);
  const bClp = locateBracket(grid.axes.clp_shift_bps, clpShiftBps);
  const bFx = locateBracket(grid.axes.fx_spot_pct, fxSpotPct);

  const { idx0: i0, idx1: i1, w: wx } = bUf;
  const { idx0: j0, idx1: j1, w: wy } = bClp;
  const { idx0: k0, idx1: k1, w: wz } = bFx;

  const v = grid.values;
  const c000 = v[i0][j0][k0];
  const c001 = v[i0][j0][k1];
  const c010 = v[i0][j1][k0];
  const c011 = v[i0][j1][k1];
  const c100 = v[i1][j0][k0];
  const c101 = v[i1][j0][k1];
  const c110 = v[i1][j1][k0];
  const c111 = v[i1][j1][k1];

  const c00 = c000 * (1 - wz) + c001 * wz;
  const c01 = c010 * (1 - wz) + c011 * wz;
  const c10 = c100 * (1 - wz) + c101 * wz;
  const c11 = c110 * (1 - wz) + c111 * wz;

  const c0 = c00 * (1 - wy) + c01 * wy;
  const c1 = c10 * (1 - wy) + c11 * wy;

  return c0 * (1 - wx) + c1 * wx;
}

export interface ComputeXvaGreeksParams {
  curves: CurveSet;
  notionalUF: number;
  maturityYears: number;
  baseVolAnnual: number;
  cptySpreadBps: number;
  ownSpreadBps: number;
  cptyLgd: number;
  ownLgd: number;
  fundingSpreadBps: number;
  wwrCorrelation?: number;
  /** Factor de escalamiento por colateral (EPE_coll / EPE_uncoll) */
  collateralScaling?: number;
}

/**
 * Calcula los Greeks completos de XVA (CS01, Own CS01, Vega, FX Delta, Rate DV01 y Theta)
 * mediante bump-and-revalue sobre el pipeline XVA (Gregory Cap. 18, FR-6.1).
 */
export function computeXvaGreeks(params: ComputeXvaGreeksParams): XvaGreeks {
  const scale = params.collateralScaling ?? 1.0;
  const rho = params.wwrCorrelation ?? 0.0;

  const evalXva = (
    vol: number,
    cptyBps: number,
    ownBps: number,
    notionalMult: number,
    dfShiftBps: number,
    matYears: number,
  ) => {
    const prof = buildAnalyticalCCSExposureProfile(
      params.curves,
      { notionalUF: params.notionalUF * notionalMult, maturityYears: Math.max(0.25, matYears) },
      Math.max(0.001, vol),
      10,
    );
    const ee = prof.expectedExposure.map((x) => x * scale);
    const ene = prof.expectedNegativeExposure.map((x) => x * scale);
    const df = prof.discountFactors.map((d, idx) =>
      d * Math.exp(-(dfShiftBps / 10_000.0) * prof.bucketTimes[idx]),
    );

    const lamC = bootstrapHazardRate(Math.max(1, cptyBps) / 10_000.0, 1.0 - params.cptyLgd);
    const lamO = bootstrapHazardRate(Math.max(1, ownBps) / 10_000.0, 1.0 - params.ownLgd);
    const dPdC = prof.bucketTimes.map((t1, idx) =>
      marginalDefaultProbability(lamC, prof.bucketStarts[idx], t1),
    );
    const dPdO = prof.bucketTimes.map((t1, idx) =>
      marginalDefaultProbability(lamO, prof.bucketStarts[idx], t1),
    );
    const survC = prof.bucketTimes.map((t1) => survivalProbability(lamC, t1));
    const survO = prof.bucketTimes.map((t1) => survivalProbability(lamO, t1));

    return computeXvaSummary({
      ee,
      ene,
      df,
      dt: prof.dt,
      cptyMarginalPd: dPdC,
      ownMarginalPd: dPdO,
      cptyLgd: params.cptyLgd,
      ownLgd: params.ownLgd,
      fundingSpreadBps: params.fundingSpreadBps,
      ownSurvival: survO,
      cptySurvival: survC,
      wwrCorrelation: rho,
      times: prof.bucketTimes,
    });
  };

  const base = evalXva(
    params.baseVolAnnual,
    params.cptySpreadBps,
    params.ownSpreadBps,
    1.0,
    0.0,
    params.maturityYears,
  );

  // CS01: +1 bp en spread CDS de la contraparte
  const cptyBump = evalXva(
    params.baseVolAnnual,
    params.cptySpreadBps + 1.0,
    params.ownSpreadBps,
    1.0,
    0.0,
    params.maturityYears,
  );
  const cs01 = cptyBump.cva - base.cva;

  // Own CS01: +1 bp en spread CDS propio
  const ownBump = evalXva(
    params.baseVolAnnual,
    params.cptySpreadBps,
    params.ownSpreadBps + 1.0,
    1.0,
    0.0,
    params.maturityYears,
  );
  const ownCs01 = ownBump.dva - base.dva;

  // Vega: +1% (+0.01) en volatilidad anualizada UF/CLP
  const volBump = evalXva(
    params.baseVolAnnual + 0.01,
    params.cptySpreadBps,
    params.ownSpreadBps,
    1.0,
    0.0,
    params.maturityYears,
  );
  const vega = volBump.cva - base.cva;

  // FX Delta: +1% en el spot UF/CLP (escala la exposición equivalente en CLP/UF)
  const fxBump = evalXva(
    params.baseVolAnnual,
    params.cptySpreadBps,
    params.ownSpreadBps,
    1.01,
    0.0,
    params.maturityYears,
  );
  const fxDelta = fxBump.cva - base.cva;

  // Rate DV01 paralelo (+1 bp en curva de descuento)
  const rateBump = evalXva(
    params.baseVolAnnual,
    params.cptySpreadBps,
    params.ownSpreadBps,
    1.0,
    1.0,
    params.maturityYears,
  );
  const rateDv01Parallel = rateBump.cva - base.cva;

  // Theta a 1 mes (acortamiento de madurez en 1/12 años)
  const thetaBump = evalXva(
    params.baseVolAnnual,
    params.cptySpreadBps,
    params.ownSpreadBps,
    1.0,
    0.0,
    Math.max(0.25, params.maturityYears - 1.0 / 12.0),
  );
  const theta1M = thetaBump.cva - base.cva;

  // DV01 por tenor sobre los flujos del swap de referencia (en UF)
  const nCoupons = Math.max(1, Math.ceil(params.maturityYears));
  const cfTimes = Array.from({ length: nCoupons }, (_, i) => ((i + 1) * params.maturityYears) / nCoupons);
  const cfAmounts = cfTimes.map((_, i) =>
    i === nCoupons - 1 ? params.notionalUF * 1.025 : params.notionalUF * 0.025,
  );
  const dv01ByTenor = computeDv01ByTenor(
    params.curves.camara_uf.zeroRates,
    params.curves.camara_uf.tenors,
    cfTimes,
    cfAmounts,
  );

  return {
    cs01,
    ownCs01,
    vega,
    fxDelta,
    rateDv01Parallel,
    dv01ByTenor,
    theta1M,
  };
}
