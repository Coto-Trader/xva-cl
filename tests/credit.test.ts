import { describe, expect, it } from 'vitest';
import { createCounterparty } from '../src/domain/builder';
import {
  bootstrapHazardCurve,
  bootstrapHazardRate,
  buildProxyCreditCurve,
  marginalDefaultProbability,
  resolveCounterpartyHazardCurve,
  survivalProbability,
} from '../src/engine/credit';

describe('Fase 2 — Credit & Hazard Bootstrap (FR-2, Cap. 12)', () => {
  it('reproduces hazard rates and marginal PDs from credit.py / demo.py within 1e-6 (FR-2.1 acceptance)', () => {
    // From demo.py:
    // COUNTERPARTY_CDS_SPREAD = 0.0150, COUNTERPARTY_RECOVERY = 0.40 -> hazard_cpty = 0.025 (2.5000%)
    // OWN_CDS_SPREAD = 0.0080, OWN_RECOVERY = 0.40 -> hazard_own = 0.013333333333333334 (1.3333%)
    const hazardCpty = bootstrapHazardRate(0.0150, 0.40);
    const hazardOwn = bootstrapHazardRate(0.0080, 0.40);

    expect(hazardCpty).toBeCloseTo(0.025, 10);
    expect(hazardOwn).toBeCloseTo(0.0080 / 0.60, 10);

    // 10 buckets on 0..5Y (dt = 0.5Y) from demo.py:
    const bucketStarts = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5];
    const bucketTimes = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];

    const refMarginalPdCpty = bucketStarts.map((t0, i) =>
      Math.exp(-0.025 * t0) - Math.exp(-0.025 * bucketTimes[i])
    );

    bucketStarts.forEach((t0, i) => {
      const pd = marginalDefaultProbability(hazardCpty, t0, bucketTimes[i]);
      expect(Math.abs(pd - refMarginalPdCpty[i])).toBeLessThan(1e-12);
    });

    // Cumulative PD over [0, 5Y] must equal 1 - S(5Y)
    const sumPd = refMarginalPdCpty.reduce((a, b) => a + b, 0);
    expect(sumPd).toBeCloseTo(1 - survivalProbability(hazardCpty, 5.0), 12);
  });

  it('bootstraps a piecewise-constant hazard curve matching bootstrap_hazard_curve in credit.py', () => {
    const tenors = [1, 3, 5];
    const spreads = [0.006, 0.012, 0.018]; // recovery = 0.4 -> LGD = 0.6 -> avg_lambda = [0.01, 0.02, 0.03]
    const curve = bootstrapHazardCurve(tenors, spreads, 0.40);

    // cumulative_hazard = [0.01*1 = 0.01, 0.02*3 = 0.06, 0.03*5 = 0.15]
    // marginal_rates = [0.01/1 = 0.01, (0.06-0.01)/2 = 0.025, (0.15-0.06)/2 = 0.045]
    expect(curve.hazardRateAt(0.5)).toBeCloseTo(0.01, 10);
    expect(curve.hazardRateAt(1.0)).toBeCloseTo(0.01, 10);
    expect(curve.hazardRateAt(2.0)).toBeCloseTo(0.025, 10);
    expect(curve.hazardRateAt(4.0)).toBeCloseTo(0.045, 10);
    expect(curve.hazardRateAt(10.0)).toBeCloseTo(0.045, 10);

    // Survival at tenor nodes matches exp(-avg_lambda[i] * tenors[i])
    expect(curve.survivalProbability(1.0)).toBeCloseTo(Math.exp(-0.01), 10);
    expect(curve.survivalProbability(3.0)).toBeCloseTo(Math.exp(-0.06), 10);
    expect(curve.survivalProbability(5.0)).toBeCloseTo(Math.exp(-0.15), 10);
  });

  it('rejects an inverted CDS curve that yields negative marginal hazard rate (FR-2.3)', () => {
    // 1Y spread = 300 bps, 3Y spread = 80 bps -> cumulative hazard decreases -> negative marginal hazard in bucket 1
    expect(() => bootstrapHazardCurve([1, 3, 5], [0.030, 0.008, 0.010], 0.40)).toThrow(
      /negative hazard rate in bucket 1/
    );
  });

  it('builds a valid proxy credit curve for illiquid counterparties by rating/sector/region (FR-2.2, Cap. 12)', () => {
    const cpty = createCounterparty({
      id: 'cpty_illiquid',
      name: 'Agricola del Valle S.A.',
      rating: 'BBB',
      sector: 'Corporate',
      region: 'Chile',
      recoveryRate: 0.40,
      proxyKey: { rating: 'BBB', sector: 'Corporate', region: 'Chile' },
    });

    const proxyCurve = buildProxyCreditCurve(cpty.proxyKey!, cpty.recoveryRate);
    expect(proxyCurve.tenors).toEqual([1, 2, 3, 5, 7, 10]);
    // 5Y spread for BBB Corporate Chile = 150 bps (0.0150)
    expect(proxyCurve.cdsSpreads[3]).toBeCloseTo(0.0150, 6);

    const hz = resolveCounterpartyHazardCurve(cpty);
    expect(hz.marginalDefaultProbability(0, 5)).toBeGreaterThan(0);
    expect(hz.marginalDefaultProbability(0, 5)).toBeLessThan(1);
  });
});
