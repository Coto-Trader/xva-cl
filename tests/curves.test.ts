import { describe, expect, it } from 'vitest';
import { sampleMarketCurves, ZeroCurve } from '../src/engine/curves';

describe('Fase 1 — ZeroCurve PCHIP & CurveSet (FR-1, Gregory Cap. 13)', () => {
  it('reproduces sample_market_curves() discount factors and PCHIP mid-bucket rates from curve_builder.py within 1e-6', () => {
    const curves = sampleMarketCurves();

    // Exact node values at 5Y from demo.py / curve_builder.py:
    // sofr: zero_rate(5.0) = 0.0400 -> DF(5.0) = exp(-0.20) = 0.8187307530779818
    // camara_clp: zero_rate(5.0) = 0.0495 -> DF(5.0) = exp(-0.2475) = 0.7807499402820312
    // camara_uf: zero_rate(5.0) = 0.0170 -> DF(5.0) = exp(-0.085) = 0.9185122844014574
    expect(curves.sofr.zeroRate(5.0)).toBeCloseTo(0.0400, 10);
    expect(curves.sofr.discountFactor(5.0)).toBeCloseTo(Math.exp(-0.0400 * 5.0), 10);

    expect(curves.camara_clp.zeroRate(5.0)).toBeCloseTo(0.0495, 10);
    expect(curves.camara_clp.discountFactor(5.0)).toBeCloseTo(Math.exp(-0.0495 * 5.0), 10);

    expect(curves.camara_uf.zeroRate(5.0)).toBeCloseTo(0.0170, 10);
    expect(curves.camara_uf.discountFactor(5.0)).toBeCloseTo(Math.exp(-0.0170 * 5.0), 10);

    // Reference bucket discount factors for camara_uf on the 10-bucket grid (0.5Y .. 5.0Y)
    // from demo.py (build_expected_exposure_profile):
    // t = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]
    const bucketTimes = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
    // SciPy PchipInterpolator reference discount factors for camara_uf:
    const refDfsUf = [
      0.9937694906233947, // t=0.5 (z=0.0125)
      0.9865905482909884, // t=1.0 (z=0.0135)
      0.9787523674005921, // t=1.5 (PCHIP between 1Y=0.0135 and 2Y=0.0150)
      0.9704455335485082, // t=2.0 (z=0.0150)
      0.9618385653876489, // t=2.5 (PCHIP between 2Y=0.0150 and 3Y=0.0160)
      0.9531337870775047, // t=3.0 (z=0.0160)
      0.9444816784405626, // t=3.5 (PCHIP between 3Y=0.0160 and 5Y=0.0170)
      0.9357948865384846, // t=4.0
      0.9271248288580405, // t=4.5
      0.9185122844014574, // t=5.0 (z=0.0170)
    ];

    bucketTimes.forEach((t, idx) => {
      const df = curves.camara_uf.discountFactor(t);
      const relErr = Math.abs(df - refDfsUf[idx]) / refDfsUf[idx];
      expect(relErr).toBeLessThan(1e-6);
    });
  });

  it('satisfies df(0) = 1, flat extrapolation outside bounds, and consistent forwardRate(t1, t2)', () => {
    const curves = sampleMarketCurves();
    const clp = curves.get('camara_clp');

    expect(clp.discountFactor(0)).toBe(1.0);
    // Flat extrapolation below min tenor (0.25Y -> 0.0620) and above max tenor (30Y -> 0.0515)
    expect(clp.zeroRate(0.05)).toBeCloseTo(0.0620, 12);
    expect(clp.zeroRate(45.0)).toBeCloseTo(0.0515, 12);

    // Forward rate relation: df(t1) * exp(-f(t1, t2) * (t2 - t1)) == df(t2)
    const f2to5 = clp.forwardRate(2.0, 5.0);
    const impliedDf5 = clp.discountFactor(2.0) * Math.exp(-f2to5 * 3.0);
    expect(impliedDf5).toBeCloseTo(clp.discountFactor(5.0), 12);

    expect(() => clp.forwardRate(5.0, 2.0)).toThrow(/strictly greater/);
  });

  it('preserves monotonicity between knots (PCHIP shape-preserving property) and validates inputs', () => {
    const curve = new ZeroCurve([1, 2, 3, 5], [0.02, 0.02, 0.04, 0.05]);
    // On flat segment [1, 2], PCHIP must stay exactly flat at 0.02 without overshooting
    expect(curve.zeroRate(1.5)).toBeCloseTo(0.02, 12);
    // On increasing segment [2, 3], rate must stay strictly between 0.02 and 0.04
    const r25 = curve.zeroRate(2.5);
    expect(r25).toBeGreaterThan(0.02);
    expect(r25).toBeLessThan(0.04);

    expect(() => new ZeroCurve([1], [0.05])).toThrow(/at least two/);
    expect(() => new ZeroCurve([1, 1], [0.05, 0.05])).toThrow(/strictly increasing/);
  });

  it('selects cheapest-to-deliver collateral curve based on highest yield (Gregory Cap. 13)', () => {
    const curves = sampleMarketCurves();
    expect(curves.selectCheapestToDeliverCurve(['UF', 'CLP', 'USD'])).toBe('CAMARA_CLP');
    expect(curves.selectCheapestToDeliverCurve(['UF', 'USD'])).toBe('SOFR');
  });
});
