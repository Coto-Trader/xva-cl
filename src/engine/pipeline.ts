/**
 * Fase 8 — Pipeline Completo End-to-End de XVA, Exposición, Sensibilidades y Cobertura.
 *
 * Orquesta de forma determinista y serializable (apta para Web Worker y tests unitarios):
 * 1. Curvas cero PCHIP (`CurveSet`).
 * 2. Crédito / Hazard curve bootstrap o Proxy obligatorio (`resolveCounterpartyHazardCurve`).
 * 3. Simulación Monte Carlo pathwise por Netting Set con resolución jerárquica de CSA
 *    (Trade Override > Global CSA, FR-7.2, Gregory Cap. 6 y Cap. 11).
 * 4. Cálculo de XVA (`net_xva = -CVA - FCA + FBA` y `accounting_xva = -CVA + DVA`, Gregory Cap. 14-16)
 *    + curva de sensibilidad Wrong-Way Risk (Gregory Cap. 17).
 * 5. Sensibilidades (DV01 por tenor, CS01, Vega, FX Delta, QuickSens 3D) y recomendaciones de cobertura
 *    con citas al libro de Jon Gregory (Cap. 18).
 */

import {
  buildNettingSets,
  createCounterparty,
  createCSA,
  createMonteCarloConfig,
  createTrade,
  resolveEffectiveCSAId,
  validatePortfolio,
} from '../domain/builder';
import type { CSA, Portfolio, Scenario, ValidationIssue } from '../domain/types';
import {
  bootstrapHazardRate,
  marginalDefaultProbability,
  resolveCounterpartyHazardCurve,
  survivalProbability,
} from './credit';
import { CurveSet, sampleMarketCurves } from './curves';
import {
  type CollateralSpikeReport,
  type ExposureProfileResult,
  collateralSpikeReport,
  simulateNettingSetExposure,
} from './exposure';
import {
  type ForcedInflationForwardCheck,
  type HedgeRecommendation,
  type SemaphoreRow,
  type SpreadTradeRecommendation,
  buildRiskSemaphoreTable,
  checkForcedInflationForward,
  recommendSpreadTrades,
  recommendXvaHedges,
} from './hedging';
import { buildAnalyticalCCSExposureProfile } from './pricing';
import {
  type QuickSensGrid,
  type XvaGreeks,
  buildQuickSensGrid,
  computeXvaGreeks,
} from './sensitivities';
import {
  type XVASummary,
  buildSimplifiedCapitalProfile,
  computeCvaWithWwr,
  computeXvaSummary,
} from './xva';

export interface WwrCurvePoint {
  rho: number;
  cvaUF: number;
  cvaCLP: number;
  netXvaUF: number;
}

export interface NettingSetResult {
  nettingSetId: string;
  counterpartyId: string;
  counterpartyName: string;
  effectiveCsaId: string;
  csaType: CSA['type'];
  tradeCount: number;
  exposure: ExposureProfileResult;
  xvaWithCsa: XVASummary;
  xvaUncollateralized: XVASummary;
}

export interface XvaPipelineOutput {
  scenarioId: string;
  scenarioName: string;
  computedAt: string;
  elapsedMs: number;
  spotUfClp: number;
  wwrCorrelation: number;
  validationIssues: ValidationIssue[];
  /** Resultado agregado en UF con CSA activo */
  xvaUF: XVASummary;
  /** Resultado agregado en UF sin CSA (para medir ahorro de colateral) */
  xvaUncollateralizedUF: XVASummary;
  /** Benchmark analítico de referencia `demo.py` (en UF) */
  demoBenchmarkUF: XVASummary;
  /** Perfil de exposición del Netting Set principal */
  exposureProfile: ExposureProfileResult;
  /** Desglose por Netting Set */
  nettingSetResults: NettingSetResult[];
  /** Curva de sensibilidad WWR para rho en [-0.75 .. +0.90] */
  wwrCurve: WwrCurvePoint[];
  /** Reporte de spike de liquidación Physical Delivery vs NDS */
  settlementSpike: CollateralSpikeReport;
  /** Greeks de XVA */
  greeks: XvaGreeks;
  /** Semáforo de riesgo DV01 por tenor */
  semaphoreTable: SemaphoreRow[];
  /** Recomendaciones de spread trades de tasas */
  spreadTrades: SpreadTradeRecommendation[];
  /** Alerta de carry UF/CLP */
  inflationCarryCheck: ForcedInflationForwardCheck;
  /** Recomendaciones de cobertura de Greeks XVA con citas a Gregory */
  hedgeRecommendations: HedgeRecommendation[];
  /** Grilla 3D QuickSens pre-computada para sliders instantáneos */
  quickSensGrid: QuickSensGrid;
}

export interface PipelineRunOptions {
  wwrCorrelation?: number;
  costOfCapitalAnnual?: number;
  onProgress?: (percent: number, stage: string) => void;
}

/**
 * Construye el escenario por defecto basado en el caso de estudio de `demo.py`:
 * Cross-Currency Swap UF/CLP a 5 años por 500,000 UF (nocional ~19,000 millones CLP),
 * contraparte corporativa chilena BBB (spread CDS/proxy 185 bps, R = 40%) y banco propio
 * (spread 95 bps, R = 40%, fondeo 110 bps).
 */
export function createDefaultSampleScenario(): Scenario {
  const curves = sampleMarketCurves();

  const cpty = createCounterparty({
    id: 'cpty_corp_cl',
    name: 'Minera & Energía Andina S.A.',
    rating: 'BBB',
    sector: 'Mining',
    region: 'Chile',
    recoveryRate: 0.40,
    creditCurve: {
      tenors: [1, 2, 3, 5, 7, 10],
      cdsSpreads: [0.0140, 0.0155, 0.0170, 0.0185, 0.0195, 0.0205],
      recoveryRate: 0.40,
    },
    proxyKey: {
      rating: 'BBB',
      sector: 'Mining',
      region: 'Chile',
    },
    ownParty: false,
  });

  const ownBank = createCounterparty({
    id: 'own_bank_cl',
    name: 'Banco XVA Chile (Own Desk)',
    rating: 'A',
    sector: 'Bank',
    region: 'Chile',
    recoveryRate: 0.40,
    creditCurve: {
      tenors: [1, 2, 3, 5, 7, 10],
      cdsSpreads: [0.0065, 0.0075, 0.0085, 0.0095, 0.0105, 0.0115],
      recoveryRate: 0.40,
    },
    proxyKey: {
      rating: 'A',
      sector: 'Bank',
      region: 'Chile',
    },
    ownParty: true,
  });

  const globalCsa = createCSA({
    id: 'csa_global_bilateral',
    scope: 'GLOBAL',
    type: 'TWO_WAY',
    thresholdOwn: 8_000, // 8,000 UF
    thresholdCpty: 8_000, // 8,000 UF
    mta: 500, // 500 UF
    initialMargin: 4_000, // 4,000 UF IM segregado
    rounding: 10,
    eligibleCcy: ['UF', 'CLP', 'USD'],
    haircuts: { UF: 0.0, CLP: 0.02, USD: 0.04 },
    mporDays: 10,
    collateralRate: 'CAMARA_UF',
    segregatedIM: true,
  });

  const tradeOverrideCsa = createCSA({
    id: 'csa_trade_zero_threshold',
    scope: 'TRADE',
    type: 'TWO_WAY',
    thresholdOwn: 0,
    thresholdCpty: 0,
    mta: 250,
    initialMargin: 6_000,
    rounding: 10,
    eligibleCcy: ['UF', 'CLP'],
    haircuts: { UF: 0.0, CLP: 0.01 },
    mporDays: 10,
    collateralRate: 'CAMARA_UF',
    segregatedIM: true,
  });

  const uncollateralizedCsa = createCSA({
    id: 'csa_none',
    scope: 'TRADE',
    type: 'NO_CSA',
    thresholdOwn: 0,
    thresholdCpty: 0,
    mta: 0,
    initialMargin: 0,
    rounding: 0,
    eligibleCcy: ['UF'],
    haircuts: { UF: 0 },
    mporDays: 10,
    collateralRate: 'CAMARA_UF',
    segregatedIM: true,
  });

  const ccsTrade = createTrade({
    id: 'trd_ccs_uf_clp_5y',
    counterpartyId: 'cpty_corp_cl',
    product: 'CCS_UF_CLP',
    notional: 500_000,
    notionalUF: 500_000,
    currency: 'UF',
    startDate: '2026-11-07',
    maturityYears: 5.0,
    direction: 'RECEIVE',
    ufClpFxFixed: 38_000,
    nonDeliverable: true,
    ufFixedRate: 0.025,
    clpLegRate: 0.055,
  });

  const counterparties = [cpty, ownBank];
  const csas = [globalCsa, tradeOverrideCsa, uncollateralizedCsa];
  const trades = [ccsTrade];
  const portfolio: Portfolio = {
    counterparties,
    csas,
    trades,
    nettingSets: buildNettingSets({ counterparties, csas, trades, nettingSets: [] }),
  };

  const mc = createMonteCarloConfig({
    numPaths: 1_000,
    gridPointsPerYear: 2,
    seed: 42,
    pathwise: true,
  });

  return {
    id: 'scen_default_ccs_uf_clp',
    name: 'CCS UF/CLP 5Y — 500k UF (Caso Base Gregory / demo.py)',
    createdAt: '2026-11-07T00:00:00.000Z',
    market: {
      asOf: '2026-11-07',
      curves: curves.toRecord(),
      fxSpot: { UFCLP: 38_000, USDCLP: 950 },
      fxVol: { UFCLP: 0.10, USDCLP: 0.12 },
      rateVol: { SOFR: 0.0050, CAMARA_CLP: 0.0065, CAMARA_UF: 0.0040 },
      fundingSpread: 0.0110, // 110 bps
    },
    portfolio,
    mc,
  };
}

/**
 * Ejecuta el motor XVA completo sobre un `Scenario` y retorna todos los perfiles,
 * métricas, sensibilidades y recomendaciones de cobertura.
 */
export function runFullXvaPipeline(
  scenario: Scenario,
  options: PipelineRunOptions = {},
): XvaPipelineOutput {
  const t0 = Date.now();
  const reportProgress = options.onProgress ?? (() => undefined);
  const wwrCorrelation = options.wwrCorrelation ?? 0.0;
  const costOfCapital = options.costOfCapitalAnnual ?? 0.10;

  reportProgress(10, 'Validando portafolio y reconstruyendo curvas PCHIP...');
  const validationIssues = validatePortfolio(scenario.portfolio);
  const curves = CurveSet.fromRecord(scenario.market.curves);
  const spotUfClp = scenario.market.fxSpot.UFCLP ?? 38_000;
  const volUfClp = scenario.market.fxVol.UFCLP ?? 0.10;
  const fundingSpreadBps = (scenario.market.fundingSpread ?? 0.0110) * 10_000.0;

  // Identificar entidad propia (ownParty) y contrapartes
  const ownParty =
    scenario.portfolio.counterparties.find((c) => c.ownParty) ??
    createCounterparty({
      id: 'own_fallback',
      name: 'Own Bank',
      rating: 'A',
      sector: 'Bank',
      region: 'Chile',
      recoveryRate: 0.40,
      proxyKey: { rating: 'A', sector: 'Bank', region: 'Chile' },
      ownParty: true,
    });
  const ownHazard = resolveCounterpartyHazardCurve(ownParty);

  reportProgress(30, 'Simulando trayectorias Monte Carlo y aplicando CSA (MPOR / Threshold / IM)...');

  const nettingSetResults: NettingSetResult[] = [];
  const csasById = new Map<string, CSA>(scenario.portfolio.csas.map((c) => [c.id, c]));
  const globalCsa =
    scenario.portfolio.csas.find((c) => c.scope === 'GLOBAL') ?? scenario.portfolio.csas[0];

  for (const ns of scenario.portfolio.nettingSets) {
    const cpty =
      scenario.portfolio.counterparties.find((c) => c.id === ns.counterpartyId) ??
      scenario.portfolio.counterparties[0];
    const cptyHazard = resolveCounterpartyHazardCurve(cpty);
    const nsTrades = scenario.portfolio.trades.filter((t) => ns.tradeIds.includes(t.id));
    if (nsTrades.length === 0) continue;

    // Regla jerárquica CSA (FR-7.2): Trade Override > Global CSA
    const resolvedCsaId = resolveEffectiveCSAId(nsTrades[0], globalCsa?.id ?? 'NO_CSA');
    const effectiveCsa = csasById.get(ns.csaId) ?? csasById.get(resolvedCsaId) ?? globalCsa;

    const { grid, profile } = simulateNettingSetExposure(
      nsTrades,
      scenario.market,
      curves,
      scenario.mc,
      effectiveCsa,
      0.99,
    );

    const discountCurveName = effectiveCsa
      ? curves.selectCheapestToDeliverCurve(effectiveCsa.eligibleCcy)
      : 'CAMARA_UF';
    const discCurve = curves.get(discountCurveName);

    const df = grid.bucketTimes.map((t) => discCurve.discountFactor(t));
    const cptyMarginalPd = grid.bucketTimes.map((t1, idx) =>
      cptyHazard.marginalDefaultProbability(grid.bucketStarts[idx], t1),
    );
    const ownMarginalPd = grid.bucketTimes.map((t1, idx) =>
      ownHazard.marginalDefaultProbability(grid.bucketStarts[idx], t1),
    );
    const cptySurv = grid.bucketTimes.map((t1) => cptyHazard.survivalProbability(t1));
    const ownSurv = grid.bucketTimes.map((t1) => ownHazard.survivalProbability(t1));

    const imAmount =
      effectiveCsa && effectiveCsa.type !== 'NO_CSA' && effectiveCsa.segregatedIM
        ? effectiveCsa.initialMargin
        : 0;
    const imProfile = grid.bucketTimes.map(() => imAmount);
    const capProfileWithCsa = buildSimplifiedCapitalProfile(profile.ee, profile.pfe);
    const capProfileUncoll = buildSimplifiedCapitalProfile(
      profile.eeUncollateralized,
      profile.pfeUncollateralized,
    );

    const xvaWithCsa = computeXvaSummary({
      ee: profile.ee,
      ene: profile.ene,
      df,
      dt: grid.dt,
      cptyMarginalPd,
      ownMarginalPd,
      cptyLgd: cptyHazard.lgd,
      ownLgd: ownHazard.lgd,
      fundingSpreadBps,
      ownSurvival: ownSurv,
      cptySurvival: cptySurv,
      imProfile,
      capitalProfile: capProfileWithCsa,
      costOfCapitalAnnual: costOfCapital,
      wwrCorrelation,
      times: grid.bucketTimes,
    });

    const xvaUncollateralized = computeXvaSummary({
      ee: profile.eeUncollateralized,
      ene: profile.eneUncollateralized,
      df,
      dt: grid.dt,
      cptyMarginalPd,
      ownMarginalPd,
      cptyLgd: cptyHazard.lgd,
      ownLgd: ownHazard.lgd,
      fundingSpreadBps,
      ownSurvival: ownSurv,
      cptySurvival: cptySurv,
      imProfile: grid.bucketTimes.map(() => 0),
      capitalProfile: capProfileUncoll,
      costOfCapitalAnnual: costOfCapital,
      wwrCorrelation,
      times: grid.bucketTimes,
    });

    nettingSetResults.push({
      nettingSetId: ns.id,
      counterpartyId: cpty.id,
      counterpartyName: cpty.name,
      effectiveCsaId: effectiveCsa?.id ?? 'csa_none',
      csaType: effectiveCsa?.type ?? 'NO_CSA',
      tradeCount: nsTrades.length,
      exposure: profile,
      xvaWithCsa,
      xvaUncollateralized,
    });
  }

  reportProgress(65, 'Calculando benchmark analítico demo.py y curva Wrong-Way Risk...');

  // Benchmark analítico demo.py
  const totalNotionalUF = scenario.portfolio.trades.reduce(
    (sum, t) => sum + (t.product === 'CCS_UF_CLP' ? t.notionalUF : t.notional / Math.max(spotUfClp, 1)),
    0,
  ) || 500_000;
  const maxMaturity = scenario.portfolio.trades.reduce((m, t) => Math.max(m, t.maturityYears), 5.0);

  const primaryCpty =
    scenario.portfolio.counterparties.find((c) => !c.ownParty) ?? scenario.portfolio.counterparties[0];
  const primaryHazard = resolveCounterpartyHazardCurve(primaryCpty);
  const cpty5YSpreadBps = primaryHazard.hazardRateAt(5.0) * primaryHazard.lgd * 10_000.0;
  const own5YSpreadBps = ownHazard.hazardRateAt(5.0) * ownHazard.lgd * 10_000.0;

  const demoProf = buildAnalyticalCCSExposureProfile(
    curves,
    { notionalUF: totalNotionalUF, maturityYears: maxMaturity },
    volUfClp,
    10,
  );
  const lamC = bootstrapHazardRate(cpty5YSpreadBps / 10_000.0, primaryHazard.recoveryRate);
  const lamO = bootstrapHazardRate(own5YSpreadBps / 10_000.0, ownHazard.recoveryRate);
  const demoDpdC = demoProf.bucketTimes.map((t1, idx) =>
    marginalDefaultProbability(lamC, demoProf.bucketStarts[idx], t1),
  );
  const demoDpdO = demoProf.bucketTimes.map((t1, idx) =>
    marginalDefaultProbability(lamO, demoProf.bucketStarts[idx], t1),
  );
  const demoSurvC = demoProf.bucketTimes.map((t1) => survivalProbability(lamC, t1));
  const demoSurvO = demoProf.bucketTimes.map((t1) => survivalProbability(lamO, t1));

  const demoBenchmarkUF = computeXvaSummary({
    ee: demoProf.expectedExposure,
    ene: demoProf.expectedNegativeExposure,
    df: demoProf.discountFactors,
    dt: demoProf.dt,
    cptyMarginalPd: demoDpdC,
    ownMarginalPd: demoDpdO,
    cptyLgd: primaryHazard.lgd,
    ownLgd: ownHazard.lgd,
    fundingSpreadBps,
    ownSurvival: demoSurvO,
    cptySurvival: demoSurvC,
    wwrCorrelation,
    times: demoProf.bucketTimes,
  });

  // Agregar resultados de Netting Sets
  const primaryNs = nettingSetResults[0];
  const xvaUF = primaryNs ? primaryNs.xvaWithCsa : demoBenchmarkUF;
  const xvaUncollateralizedUF = primaryNs ? primaryNs.xvaUncollateralized : demoBenchmarkUF;
  const exposureProfile = primaryNs
    ? primaryNs.exposure
    : {
        times: demoProf.bucketTimes,
        ee: demoProf.expectedExposure,
        ene: demoProf.expectedNegativeExposure,
        pfe: demoProf.expectedExposure.map((v) => v * 2.33),
        eeUncollateralized: demoProf.expectedExposure,
        eneUncollateralized: demoProf.expectedNegativeExposure,
        pfeUncollateralized: demoProf.expectedExposure.map((v) => v * 2.33),
        expectedCollateral: demoProf.bucketTimes.map(() => 0),
        eee: demoProf.expectedExposure,
        epe: demoProf.expectedExposure.reduce((a, b) => a + b, 0) / demoProf.expectedExposure.length,
        eepe: demoProf.expectedExposure[1] ?? 0,
        epeUncollateralized:
          demoProf.expectedExposure.reduce((a, b) => a + b, 0) / demoProf.expectedExposure.length,
      };

  // Curva de sensibilidad WWR para rho en [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 0.90]
  const rhoGrid = [-0.75, -0.50, -0.25, 0.0, 0.25, 0.50, 0.75, 0.90];
  const wwrCurve: WwrCurvePoint[] = rhoGrid.map((rho) => {
    const cvaRho = computeCvaWithWwr(
      exposureProfile.ee,
      demoProf.discountFactors.slice(0, exposureProfile.times.length),
      demoDpdC.slice(0, exposureProfile.times.length),
      primaryHazard.lgd,
      rho,
      exposureProfile.times,
    );
    return {
      rho,
      cvaUF: cvaRho,
      cvaCLP: cvaRho * spotUfClp,
      netXvaUF: -cvaRho - xvaUF.fca + xvaUF.fba,
    };
  });

  reportProgress(85, 'Calculando Greeks XVA, grilla QuickSens 3D y recomendaciones de cobertura...');

  const collScale =
    exposureProfile.epeUncollateralized > 0
      ? Math.max(0.05, exposureProfile.epe / exposureProfile.epeUncollateralized)
      : 1.0;

  const greeks = computeXvaGreeks({
    curves,
    notionalUF: totalNotionalUF,
    maturityYears: maxMaturity,
    baseVolAnnual: volUfClp,
    cptySpreadBps: cpty5YSpreadBps,
    ownSpreadBps: own5YSpreadBps,
    cptyLgd: primaryHazard.lgd,
    ownLgd: ownHazard.lgd,
    fundingSpreadBps,
    wwrCorrelation,
    collateralScaling: collScale,
  });

  // Escalar DV01 por tenor a CLP para la tabla de semáforo
  const dv01ClpByTenor: Record<string, number> = {};
  for (const [k, v] of Object.entries(greeks.dv01ByTenor)) {
    dv01ClpByTenor[k] = v * spotUfClp;
  }

  const semaphoreTable = buildRiskSemaphoreTable(dv01ClpByTenor);
  const spreadTrades = recommendSpreadTrades(dv01ClpByTenor, 0.80);
  const inflationCarryCheck = checkForcedInflationForward(
    curves.camara_uf.zeroRate(1.0),
    curves.camara_clp.zeroRate(1.0),
    -35.0,
  );

  const hasLiquidCds = Boolean(
    primaryCpty.creditCurve && primaryCpty.creditCurve.tenors.length > 0,
  );
  const proxyLabel = primaryCpty.proxyKey
    ? `Proxy ${primaryCpty.proxyKey.rating} · ${primaryCpty.proxyKey.sector} · ${primaryCpty.proxyKey.region}`
    : 'CDX.EM / Bono Corporativo Chile';

  const hedgeRecommendations = recommendXvaHedges(greeks, {
    hasLiquidCds,
    proxyLabel,
    notionalUF: totalNotionalUF,
  });

  const settlementSpike = collateralSpikeReport(totalNotionalUF * spotUfClp, volUfClp);

  const quickSensGrid = buildQuickSensGrid((ufBps, clpBps, fxPct) => {
    const fxFactor = 1.0 + fxPct;
    const rateEffect = (ufBps - 0.6 * clpBps) * greeks.rateDv01Parallel;
    return (xvaUF.net_xva + rateEffect) * fxFactor;
  });

  reportProgress(100, 'Cálculo XVA finalizado.');

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    computedAt: new Date().toISOString(),
    elapsedMs: Math.max(1, Date.now() - t0),
    spotUfClp,
    wwrCorrelation,
    validationIssues,
    xvaUF,
    xvaUncollateralizedUF,
    demoBenchmarkUF,
    exposureProfile,
    nettingSetResults,
    wwrCurve,
    settlementSpike,
    greeks,
    semaphoreTable,
    spreadTrades,
    inflationCarryCheck,
    hedgeRecommendations,
    quickSensGrid,
  };
}
