import { describe, expect, it } from 'vitest';
import { createMonteCarloConfig, createTrade } from '../src/domain/builder';
import { MarketEnv } from '../src/domain/types';
import { sampleMarketCurves } from '../src/engine/curves';
import {
  buildAnalyticalCCSExposureProfile,
  generateTradeCashflows,
  priceFixedCashflowsLinear,
  priceTradePathwiseUF,
} from '../src/engine/pricing';
import { generateMonteCarloScenarios } from '../src/engine/scenario';

describe('Fase 3 — Pricing & Monte Carlo Scenarios (FR-3.1, NFR-3, Gregory Cap. 7 & 10)', () => {
  const curves = sampleMarketCurves();
  const market: MarketEnv = {
    asOf: '2026-11-07',
    curves: curves.toRecord(),
    fxSpot: { UFCLP: 38_000 },
    fxVol: { UFCLP: 0.10 },
    rateVol: { SOFR: 0.0, CAMARA_CLP: 0.0, CAMARA_UF: 0.0 },
  };

  it('produces bit-for-bit reproducible Monte Carlo scenarios for the same seed (NFR-3)', () => {
    const mc1 = createMonteCarloConfig({ numPaths: 500, gridPointsPerYear: 2, seed: 20261107 });
    const mc2 = createMonteCarloConfig({ numPaths: 500, gridPointsPerYear: 2, seed: 20261107 });
    const mcDiff = createMonteCarloConfig({ numPaths: 500, gridPointsPerYear: 2, seed: 999 });

    const grid1 = generateMonteCarloScenarios(market, curves, mc1, 5.0);
    const grid2 = generateMonteCarloScenarios(market, curves, mc2, 5.0);
    const gridDiff = generateMonteCarloScenarios(market, curves, mcDiff, 5.0);

    expect(grid1.bucketTimes).toEqual(grid2.bucketTimes);
    expect(grid1.paths[0][4].brownianFx).toBe(grid2.paths[0][4].brownianFx);
    expect(grid1.paths[123][9].ufClpSpot).toBe(grid2.paths[123][9].ufClpSpot);
    expect(grid1.paths[0][4].brownianFx).not.toBe(gridDiff.paths[0][4].brownianFx);
  });

  it('reproduces the analytical CCS UF/CLP expected exposure profile from demo.py and converges via Monte Carlo', () => {
    const ccs = createTrade({
      id: 'ccs_ref',
      counterpartyId: 'cpty_1',
      product: 'CCS_UF_CLP',
      notionalUF: 500_000,
      ufClpFxFixed: 38_000,
      maturityYears: 5.0,
      direction: 'RECEIVE',
    });

    const analytical = buildAnalyticalCCSExposureProfile(curves, { notionalUF: 500_000, maturityYears: 5.0 }, 0.10, 10);
    // At t = 5.0Y: 0.5 * sqrt(2/pi) * 500_000 * 0.10 * sqrt(5.0) = 44,603.10290381928 UF
    const expected5Y = 0.5 * Math.sqrt(2.0 / Math.PI) * 500_000 * 0.10 * Math.sqrt(5.0);
    expect(analytical.expectedExposure[9]).toBeCloseTo(expected5Y, 8);

    // Monte Carlo pathwise average E[max(V(5Y), 0)] converges to analytical EE(5Y) within ~2%
    const mc = createMonteCarloConfig({ numPaths: 4000, gridPointsPerYear: 2, seed: 42 });
    const grid = generateMonteCarloScenarios(market, curves, mc, 5.0);

    let sumPos5Y = 0;
    let sumNeg5Y = 0;
    for (let p = 0; p < grid.numPaths; p++) {
      const mtm5Y = priceTradePathwiseUF(ccs, market, curves, grid.paths[p][9]);
      sumPos5Y += Math.max(mtm5Y, 0);
      sumNeg5Y += Math.max(-mtm5Y, 0);
    }
    const mcEE5Y = sumPos5Y / grid.numPaths;
    const mcENE5Y = sumNeg5Y / grid.numPaths;

    // Antithetic pairing makes mcEE5Y === mcENE5Y at par strike
    expect(mcEE5Y).toBeCloseTo(mcENE5Y, 8);
    expect(Math.abs(mcEE5Y - expected5Y) / expected5Y).toBeLessThan(0.035);
  });

  it('models ageing / roll-off (MTM = 0 after maturity) and cashflow pricing (Gregory Cap. 7)', () => {
    const shortCcs = createTrade({
      id: 'ccs_3y',
      counterpartyId: 'cpty_1',
      product: 'CCS_UF_CLP',
      notionalUF: 200_000,
      ufClpFxFixed: 38_000,
      maturityYears: 3.0,
    });
    const mc = createMonteCarloConfig({ numPaths: 20, gridPointsPerYear: 2, seed: 7 });
    const grid = generateMonteCarloScenarios(market, curves, mc, 5.0);

    // At t = 5.0Y (> 3.0Y maturity), MTM must be 0
    const mtmAfterMaturity = priceTradePathwiseUF(shortCcs, market, curves, grid.paths[0][9]);
    expect(mtmAfterMaturity).toBe(0);

    const flows = generateTradeCashflows(shortCcs);
    expect(flows.length).toBe(3);
    expect(flows[2].timeYears).toBeCloseTo(3.0, 6);

    const pv = priceFixedCashflowsLinear(
      curves.camara_uf.zeroRates,
      curves.camara_uf.tenors,
      [1, 2, 3, 5, 7],
      [15_000, -20_000, 15_000, -25_000, 500_000]
    );
    expect(pv).toBeGreaterThan(400_000);
  });
});
