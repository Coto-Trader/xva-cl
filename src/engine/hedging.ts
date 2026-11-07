/**
 * Fase 7 — Motor de Recomendación de Coberturas XVA y Semáforo de Riesgo DV01.
 *
 * Referencias:
 * - Jon Gregory, "The xVA Challenge" (3rd ed., 2015):
 *   - Cap. 12 (Credit Spreads, Proxy Hedging para contrapartes sin CDS líquido e IFRS 13)
 *   - Cap. 14 (DVA no cubrible directamente con propio CDS; uso de proxies financieros)
 *   - Cap. 17 (Cobertura de Wrong-Way Risk y correlación exposición-crédito)
 *   - Cap. 18 (Managing xVA: cobertura de CS01, Vega de exposición, Rate DV01, FX Delta y Cross-Gamma)
 * - Reproduce `hedging/advisor.py` (semáforo DV01, spread trades y alerta de carry UF/CLP)
 *   y extiende con `recommendXvaHedges` según `docs/HEDGING-STRATEGIES.md` y FR-6.2 / FR-6.3.
 */

import type { XvaGreeks } from './sensitivities';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SemaphoreRow {
  tenor: number;
  dv01: number;
  level: RiskLevel;
  action: string;
}

export interface SpreadTradeRecommendation {
  short_tenor: number;
  long_tenor: number;
  pay_leg_dv01: number;
  receive_leg_dv01: number;
  net_dv01_after_hedge: number;
  rationale: string;
}

export interface ForcedInflationForwardCheck {
  forced_hedge_required: boolean;
  carry_bps: number;
  limit_bps: number;
  recommendation: string;
}

export interface HedgeRecommendation {
  id: string;
  greek: 'VEGA' | 'CS01' | 'RATE_DV01' | 'FX_DELTA' | 'OWN_CS01';
  greekValue: number;
  unit: string;
  /** Acción recomendada ("Vender vega", "Comprar vega", "Comprar protección CDS", etc.) */
  action: string;
  /** Instrumento de cobertura sugerido */
  instrument: string;
  /** Nocional o tamaño sugerido para neutralizar el Greek */
  sizedAmount: string;
  /** Deterioro proyectado de XVA ante un shock adverso estándar sin cobertura (en UF) */
  projectedDeteriorationUF: number;
  /** Costo estimado de ejecución/bid-offer hoy (en UF) */
  estimatedHedgeCostUF: number;
  /** Regla cuantitativa explícita del libro */
  bookRule: string;
  /** Cita del capítulo de Jon Gregory (3rd ed., 2015) */
  bookChapter: string;
  /** Nota de criterio contable IFRS 13 vs visión económica */
  accountingNote: string;
}

/**
 * Clasifica el DV01 de un nodo en semáforo LOW / MEDIUM / HIGH (`classify_tenor_risk` en `hedging/advisor.py`).
 *
 * // SUPUESTO (no en Gregory): Umbrales operativos `mediumThreshold = 25_000` y `highThreshold = 75_000`
 * tomados de `hedging/advisor.py`.
 */
export function classifyTenorRisk(
  dv01: number,
  mediumThreshold = 25_000.0,
  highThreshold = 75_000.0,
): RiskLevel {
  const absVal = Math.abs(dv01);
  if (absVal >= highThreshold) return 'HIGH';
  if (absVal >= mediumThreshold) return 'MEDIUM';
  return 'LOW';
}

/**
 * Construye la tabla de semáforo de riesgo por tenor ordenada cronológicamente
 * (`build_risk_semaphore_table` en `hedging/advisor.py`).
 */
export function buildRiskSemaphoreTable(
  dv01ByTenor: Record<string | number, number>,
  mediumThreshold = 25_000.0,
  highThreshold = 75_000.0,
): SemaphoreRow[] {
  const entries = Object.entries(dv01ByTenor)
    .map(([k, v]) => ({ tenor: Number(k), dv01: Number(v) }))
    .filter((e) => Number.isFinite(e.tenor))
    .sort((a, b) => a.tenor - b.tenor);

  return entries.map(({ tenor, dv01 }) => {
    const level = classifyTenorRisk(dv01, mediumThreshold, highThreshold);
    let action: string;
    if (level === 'HIGH') {
      const direction = dv01 > 0 ? 'PAY FIXED' : 'RECEIVE FIXED';
      action = `URGENT HEDGE (${direction}) at ${tenor}Y`;
    } else if (level === 'MEDIUM') {
      action = `Monitor / partial hedge at ${tenor}Y`;
    } else {
      action = 'Within desk limits';
    }
    return { tenor, dv01, level, action };
  });
}

/**
 * Sugiere un spread trade (steepener/flattener) cuando existen nodos con signos opuestos de DV01,
 * o una cobertura direccional en el tenor pico (`recommend_spread_trades` en `hedging/advisor.py`).
 */
export function recommendSpreadTrades(
  dv01ByTenor: Record<string | number, number>,
  hedgeRatio = 0.80,
): SpreadTradeRecommendation[] {
  if (hedgeRatio <= 0 || hedgeRatio > 1.0) {
    throw new Error('hedgeRatio must be in (0, 1].');
  }
  const entries = Object.entries(dv01ByTenor)
    .map(([k, v]) => [Number(k), Number(v)] as [number, number])
    .filter(([t]) => Number.isFinite(t));

  if (entries.length < 2) return [];

  const posNodes = entries.filter(([, v]) => v > 0);
  const negNodes = entries.filter(([, v]) => v < 0);

  if (posNodes.length === 0 || negNodes.length === 0) {
    const [peakTenor, peakDv01] = entries.reduce((best, cur) =>
      Math.abs(cur[1]) > Math.abs(best[1]) ? cur : best,
    );
    const hedged = peakDv01 * (1.0 - hedgeRatio);
    return [
      {
        short_tenor: peakTenor,
        long_tenor: peakTenor,
        pay_leg_dv01: -peakDv01 * hedgeRatio,
        receive_leg_dv01: 0.0,
        net_dv01_after_hedge: hedged,
        rationale: `Directional outright hedge at ${peakTenor}Y (${Math.round(hedgeRatio * 100)}% ratio).`,
      },
    ];
  }

  const [maxPosTenor, maxPosDv01] = posNodes.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  const [maxNegTenor, maxNegDv01] = negNodes.reduce((best, cur) => (cur[1] < best[1] ? cur : best));

  const shortTenor = Math.min(maxPosTenor, maxNegTenor);
  const longTenor = Math.max(maxPosTenor, maxNegTenor);
  const matchedDv01 = Math.min(Math.abs(maxPosDv01), Math.abs(maxNegDv01)) * hedgeRatio;
  const residual = maxPosDv01 + maxNegDv01;

  return [
    {
      short_tenor: shortTenor,
      long_tenor: longTenor,
      pay_leg_dv01: -matchedDv01,
      receive_leg_dv01: matchedDv01,
      net_dv01_after_hedge: residual * (1.0 - hedgeRatio),
      rationale: `Curve spread trade ${shortTenor}Y vs ${longTenor}Y offsetting opposite-sign bucket exposures (${Math.round(hedgeRatio * 100)}% hedge ratio).`,
    },
  ];
}

/**
 * Evalúa si el carry diferencial UF vs CLP supera el umbral negativo que obliga a cubrir con
 * Forward de Inflación UF (`check_forced_inflation_forward` en `hedging/advisor.py`).
 *
 * // SUPUESTO (no en Gregory): Regla operativa chilena de carry negativo UF/CLP (`maxNegativeCarryBps = -35 bps`).
 */
export function checkForcedInflationForward(
  ufCarryAnnual: number,
  clpCarryAnnual: number,
  maxNegativeCarryBps = -35.0,
): ForcedInflationForwardCheck {
  const netCarryBps = (ufCarryAnnual - clpCarryAnnual) * 10_000.0;
  const isForced = netCarryBps < maxNegativeCarryBps;
  return {
    forced_hedge_required: isForced,
    carry_bps: netCarryBps,
    limit_bps: maxNegativeCarryBps,
    recommendation: isForced
      ? 'EXECUTE UF Inflation Forward to lock breakeven CPI and cap negative carry.'
      : 'Carry within tolerance; keep dynamic CAMARA/UF swap hedge.',
  };
}

export interface RecommendXvaHedgesOptions {
  hasLiquidCds?: boolean;
  proxyLabel?: string;
  notionalUF?: number;
}

/**
 * Genera las recomendaciones de cobertura de Greeks de XVA (Vega, CS01, Rate DV01, FX Delta, Own CS01)
 * siguiendo estrictamente `docs/HEDGING-STRATEGIES.md`, FR-6.2 y FR-6.3 (Gregory Cap. 12, 14, 17, 18).
 *
 * Regla clave de aceptación FR-6:
 * - Si `vega > 0` (mayor volatilidad incrementa la EE y por ende encarece el CVA):
 *   la acción recomendada contiene explícitamente `"Vender vega"` para compensar el incremento de CVA
 *   cuando sube la volatilidad implícita.
 * - Si `vega < 0`: la acción recomendada contiene `"Comprar vega"`.
 */
export function recommendXvaHedges(
  greeks: XvaGreeks,
  options: RecommendXvaHedgesOptions = {},
): HedgeRecommendation[] {
  const hasLiquidCds = options.hasLiquidCds ?? false;
  const proxyLabel = options.proxyLabel ?? 'CDX.EM / Bono Soberano-Corporativo Chile';
  const notionalUF = options.notionalUF ?? 500_000;

  const recs: HedgeRecommendation[] = [];

  // 1. Cobertura de Vega de Exposición (FR-6 aceptación: vega > 0 -> "Vender vega")
  const vegaAbs = Math.abs(greeks.vega);
  const vegaAction =
    greeks.vega >= 0
      ? 'Vender vega (Vender Opciones FX UF/CLP o Swaptions para compensar alza de CVA por volatilidad)'
      : 'Comprar vega (Comprar Opciones FX UF/CLP o Swaptions)';
  // Deterioro proyectado ante shock de +3 puntos de vol; costo hoy ~0.35 pts de bid-offer
  const vegaDeterioration = vegaAbs * 3.0;
  const vegaCost = vegaAbs * 0.35;

  recs.push({
    id: 'hedge_vega',
    greek: 'VEGA',
    greekValue: greeks.vega,
    unit: 'UF / +1% vol',
    action: vegaAction,
    instrument: 'Opciones FX USD/CLP - UF/CLP ATM Straddle / Swaption Europea 5Y',
    sizedAmount: `${Math.max(1, Math.round(vegaAbs)).toLocaleString('es-CL')} UF vega nocional`,
    projectedDeteriorationUF: vegaDeterioration,
    estimatedHedgeCostUF: vegaCost,
    bookRule:
      'Si Vega(CVA) > 0, la exposición positiva esperada EE(t) crece con la volatilidad del subyacente; el escritorio XVA está corto volatilidad en su CVA (-CVA disminuye cuando sube sigma) y debe vender/estructurar posición de vega acorde a su convención de signo para inmunizar el P&L ante spikes de volatilidad.',
    bookChapter: 'Jon Gregory (2015), Cap. 18 — Managing xVA (Exposure Vega & Cross-Gamma)',
    accountingNote:
      'Bajo IFRS 13 el CVA debe valorizarse con volatilidades implícitas de mercado (risk-neutral) para reflejar el costo de reposición de las coberturas de vega.',
  });

  // 2. Cobertura de CS01 de Contraparte (CDS directo o Proxy Index/Bond)
  const cs01Abs = Math.abs(greeks.cs01);
  const cs01Action = hasLiquidCds
    ? 'Comprar protección CDS Single-Name sobre la contraparte'
    : `Comprar protección CDS Proxy (${proxyLabel}) para cubrir spread y jump-to-default`;
  // Deterioro proyectado ante +50 bps de ampliación de spread crediticio vs ~4 bps de bid-offer
  const cs01Deterioration = cs01Abs * 50.0;
  const cs01Cost = cs01Abs * 4.0;

  recs.push({
    id: 'hedge_cs01',
    greek: 'CS01',
    greekValue: greeks.cs01,
    unit: 'UF / +1 bp CDS',
    action: cs01Action,
    instrument: hasLiquidCds
      ? 'CDS 5Y Single-Name (ISDA Standard)'
      : `Índice CDS ${proxyLabel} / TRS Bono Corporativo`,
    sizedAmount: `${Math.max(1, Math.round(cs01Abs)).toLocaleString('es-CL')} UF/bp CS01`,
    projectedDeteriorationUF: cs01Deterioration,
    estimatedHedgeCostUF: cs01Cost,
    bookRule:
      'El CS01 mide la sensibilidad del CVA al ensanchamiento de spreads de crédito. Cuando no existe CDS single-name líquido (caso habitual en mercado chileno), se mapea un proxy por rating, sector y región que cubre el riesgo sistémico de spread, dejando el riesgo idiosincrático (jump-to-default) sujeto a límites de PFE.',
    bookChapter: 'Jon Gregory (2015), Cap. 12 (Credit Spreads & Proxies) y Cap. 18 (CDS Hedging)',
    accountingNote:
      'IFRS 13 exige probabilidades de default riesgo-neutrales extraídas de spreads observables o proxies de mercado, ya que el escritorio XVA marca a mercado el costo de cubrir el CS01.',
  });

  // 3. Cobertura de Rate DV01 (Sensibilidad de exposición y descuento a tasas)
  const rateDv01Abs = Math.abs(greeks.rateDv01Parallel);
  const rateAction =
    greeks.rateDv01Parallel >= 0
      ? 'Recibir fijo IRS CAMARA_UF / Pagar fijo IRS CAMARA_CLP'
      : 'Pagar fijo IRS CAMARA_UF / Recibir fijo IRS CAMARA_CLP';
  const rateDeterioration = rateDv01Abs * 25.0; // Shock de 25 bps en curvas
  const rateCost = rateDv01Abs * 1.5; // ~1.5 bps bid-offer en swap local

  recs.push({
    id: 'hedge_rate_dv01',
    greek: 'RATE_DV01',
    greekValue: greeks.rateDv01Parallel,
    unit: 'UF / +1 bp tasa',
    action: rateAction,
    instrument: 'Swap Promedio Cámara (SPC) CLP y UF 5Y (OIS local)',
    sizedAmount: `${Math.max(1, Math.round(rateDv01Abs * 100) / 100)} UF/bp DV01`,
    projectedDeteriorationUF: rateDeterioration,
    estimatedHedgeCostUF: rateCost,
    bookRule:
      'El DV01 del XVA combina el efecto del factor de descuento OIS y la deriva del MTM esperado del portafolio ante movimientos paralelos y de pendiente en las curvas cero.',
    bookChapter: 'Jon Gregory (2015), Cap. 13 (Discounting & Collateral) y Cap. 18 (Managing xVA)',
    accountingNote:
      'El descuento de la exposición colateralizada se realiza a la curva OIS de la moneda del colateral (Cheapest-to-Deliver).',
  });

  // 4. Cobertura de FX Delta (UF/CLP spot)
  const fxDeltaAbs = Math.abs(greeks.fxDelta);
  const fxAction =
    greeks.fxDelta >= 0
      ? 'Vender FX Forward UF/CLP (NDF) para cubrir exposición al alza de la UF'
      : 'Comprar FX Forward UF/CLP (NDF)';
  const fxDeterioration = fxDeltaAbs * 2.5; // Shock de 2.5% en UF/CLP
  const fxCost = fxDeltaAbs * 0.20;

  recs.push({
    id: 'hedge_fx_delta',
    greek: 'FX_DELTA',
    greekValue: greeks.fxDelta,
    unit: 'UF / +1% FX',
    action: fxAction,
    instrument: 'Forward UF/CLP Non-Deliverable (Compensación 1 día fixing)',
    sizedAmount: `${Math.round(notionalUF * 0.10).toLocaleString('es-CL')} UF equivalente`,
    projectedDeteriorationUF: fxDeterioration,
    estimatedHedgeCostUF: fxCost,
    bookRule:
      'En Cross-Currency Swaps UF/CLP la deriva inflacionaria incrementa el nocional equivalente en CLP. Cubrir mediante NDF evita el spike de riesgo de liquidación (Herstatt) de entrega física.',
    bookChapter: 'Jon Gregory (2015), Cap. 6 (Settlement & Netting) y Cap. 18 (Market Risk Hedges)',
    accountingNote:
      'Separa la cobertura del MTM libre de riesgo respecto del Delta inducido por el ajuste XVA.',
  });

  // 5. Nota sobre Own CS01 (DVA) — No vendible directamente (Gregory Cap. 14 y Cap. 15)
  const ownCs01Abs = Math.abs(greeks.ownCs01);
  recs.push({
    id: 'hedge_own_cs01',
    greek: 'OWN_CS01',
    greekValue: greeks.ownCs01,
    unit: 'UF / +1 bp Own CDS',
    action: 'NO operar CDS propio — Excluir DVA de pricing económico (Gestionar vía FBA / Tesorería)',
    instrument: 'Índice CDS Financiero Proxy (sólo para cobertura macro de balance IFRS 13)',
    sizedAmount: `${Math.max(1, Math.round(ownCs01Abs)).toLocaleString('es-CL')} UF/bp Own CS01`,
    projectedDeteriorationUF: ownCs01Abs * 25.0,
    estimatedHedgeCostUF: ownCs01Abs * 5.0,
    bookRule:
      'Un banco no puede vender protección CDS sobre sí mismo para monetizar DVA. En pricing económico se incluye únicamente FBA y se excluye DVA para evitar el doble conteo del beneficio de fondeo propio.',
    bookChapter: 'Jon Gregory (2015), Cap. 14 (DVA Controversy) y Cap. 15 (FVA vs DVA Double Counting)',
    accountingNote:
      'IFRS 13 exige reportar DVA en estados financieros (-CVA + DVA), pero la mesa de pricing cotiza net_xva = -CVA - FCA + FBA.',
  });

  return recs;
}
