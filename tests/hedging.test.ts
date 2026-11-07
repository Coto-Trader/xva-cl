import { describe, expect, it } from 'vitest';
import { sampleMarketCurves } from '../src/engine/curves';
import {
  buildRiskSemaphoreTable,
  checkForcedInflationForward,
  classifyTenorRisk,
  recommendSpreadTrades,
  recommendXvaHedges,
} from '../src/engine/hedging';
import {
  buildQuickSensGrid,
  computeDeltasAnalytical,
  computeDeltasFiniteDiff,
  computeDv01ByTenor,
  computeXvaGreeks,
  defaultQuickSensAxes,
  interpolateQuickSens,
} from '../src/engine/sensitivities';

describe('Fase 7 — Sensitivities (AAD/Analytical vs FD, QuickSens 3D Grid, XVA Greeks) & Hedging Advisor (FR-6, Gregory Cap. 12, 14, 18)', () => {
  const curves = sampleMarketCurves();

  it('reproduces sensitivities/aad.py: analytical zero-rate deltas match central finite differences within 1e-6', () => {
    const tenors = [...curves.camara_uf.tenors];
    const zeroRates = [...curves.camara_uf.zeroRates];
    const cfTimes = [1.0, 2.0, 3.0, 4.0, 5.0];
    const cfAmounts = [12_500, 12_500, 12_500, 12_500, 512_500];

    const gradAnalytical = computeDeltasAnalytical(zeroRates, tenors, cfTimes, cfAmounts);
    const gradFd = computeDeltasFiniteDiff(zeroRates, tenors, cfTimes, cfAmounts, 1e-5);

    expect(gradAnalytical.length).toBe(tenors.length);
    for (let i = 0; i < tenors.length; i++) {
      const relErr = Math.abs(gradAnalytical[i] - gradFd[i]) / Math.max(1.0, Math.abs(gradAnalytical[i]));
      expect(relErr).toBeLessThan(1e-6);
    }

    const dv01Map = computeDv01ByTenor(zeroRates, tenors, cfTimes, cfAmounts);
    expect(dv01Map['5.00']).toBeLessThan(0); // Paying higher discount rate lowers positive PV
    expect(Math.abs(dv01Map['5.00'])).toBeGreaterThan(Math.abs(dv01Map['1.00']));
  });

  it('reproduces sensitivities/quicksens_grid.py: 3D trilinear interpolation is exact on linear functions and knots', () => {
    const axes = defaultQuickSensAxes();
    const linearPricer = (ufBps: number, clpBps: number, fxPct: number) =>
      -250.0 + 1.5 * ufBps - 0.8 * clpBps + 4000.0 * fxPct;

    const grid = buildQuickSensGrid(linearPricer, axes);

    // Exact at interior point (23.5 bps UF, -42.0 bps CLP, 0.031 FX)
    const interp = interpolateQuickSens(grid, 23.5, -42.0, 0.031);
    const exact = linearPricer(23.5, -42.0, 0.031);
    expect(interp).toBeCloseTo(exact, 10);

    // Clamping outside bounds matches boundary value
    const clampedHigh = interpolateQuickSens(grid, 500.0, 500.0, 0.50);
    expect(clampedHigh).toBeCloseTo(linearPricer(150.0, 200.0, 0.10), 10);
  });

  it('reproduces hedging/advisor.py: risk semaphore table, spread trades, and forced inflation forward check', () => {
    expect(classifyTenorRisk(10_000)).toBe('LOW');
    expect(classifyTenorRisk(40_000)).toBe('MEDIUM');
    expect(classifyTenorRisk(-90_000)).toBe('HIGH');

    const dv01ByTenor = {
      1.0: -15_000,
      3.0: 45_000,
      5.0: -95_000,
    };

    const table = buildRiskSemaphoreTable(dv01ByTenor);
    expect(table.length).toBe(3);
    expect(table[0].level).toBe('LOW');
    expect(table[1].level).toBe('MEDIUM');
    expect(table[2].level).toBe('HIGH');
    expect(table[2].action).toContain('URGENT HEDGE (RECEIVE FIXED)');

    const spreads = recommendSpreadTrades(dv01ByTenor, 0.80);
    expect(spreads.length).toBe(1);
    expect(spreads[0].short_tenor).toBe(3.0);
    expect(spreads[0].long_tenor).toBe(5.0);

    const carryForced = checkForcedInflationForward(0.015, 0.055, -35.0);
    expect(carryForced.forced_hedge_required).toBe(true);
    expect(carryForced.carry_bps).toBeCloseTo(-400.0, 6);
  });

  it('FR-6 Acceptance: computes XVA Greeks and when Vega > 0 recommends "Vender vega" with Gregory chapter citation', () => {
    const greeks = computeXvaGreeks({
      curves,
      notionalUF: 500_000,
      maturityYears: 5.0,
      baseVolAnnual: 0.10,
      cptySpreadBps: 185,
      ownSpreadBps: 95,
      cptyLgd: 0.60,
      ownLgd: 0.60,
      fundingSpreadBps: 110,
    });

    expect(greeks.vega).toBeGreaterThan(0);
    expect(greeks.cs01).toBeGreaterThan(0);
    expect(greeks.ownCs01).toBeGreaterThan(0);

    const recommendations = recommendXvaHedges(greeks, {
      hasLiquidCds: false,
      proxyLabel: 'CDX.EM / Bono Corporativo BBB Chile',
      notionalUF: 500_000,
    });

    const vegaRec = recommendations.find((r) => r.greek === 'VEGA');
    expect(vegaRec).toBeDefined();
    expect(vegaRec!.action).toContain('Vender vega');
    expect(vegaRec!.bookRule.length).toBeGreaterThan(20);
    expect(vegaRec!.bookChapter).toContain('Cap. 18');
    expect(vegaRec!.projectedDeteriorationUF).toBeGreaterThan(vegaRec!.estimatedHedgeCostUF);

    const cs01Rec = recommendations.find((r) => r.greek === 'CS01');
    expect(cs01Rec).toBeDefined();
    expect(cs01Rec!.action).toContain('Proxy');
    expect(cs01Rec!.bookChapter).toContain('Cap. 12');
  });
});
