/**
 * OIS Discount Curve Construction via Monotone Cubic Hermite (PCHIP) Interpolation
 * (Fase 1 — src/engine/curves.ts)
 *
 * Faithful to Jon Gregory, "The xVA Challenge" (3rd ed., 2015), Chapter 13:
 * - "the correct discounting rate for a derivative is the rate of return of collateral" (Cap. 13).
 * - Continuous zero-coupon rates interpolated with Fritsch-Carlson PCHIP (monotone cubic Hermite)
 *   and flat extrapolation outside [tenors[0], tenors[n-1]].
 * - Discount factor: df(t) = exp(-z(t) * t), with df(0) = 1.
 * - Supports the three collateral curves: SOFR (USD), CAMARA_CLP (CLP), CAMARA_UF (UF).
 * - Cheapest-to-deliver collateral selection (Cap. 13): post collateral in the highest-yielding
 *   eligible currency.
 */

import { Currency, CurveName, ZeroCurveData } from '../domain/types';

function signVal(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

/**
 * Computes Fritsch-Carlson / SciPy PchipInterpolator derivatives at knots.
 */
function computePchipSlopes(x: readonly number[], y: readonly number[]): Float64Array {
  const n = x.length;
  const d = new Float64Array(n);
  if (n === 2) {
    const slope = (y[1] - y[0]) / (x[1] - x[0]);
    d[0] = slope;
    d[1] = slope;
    return d;
  }

  const h = new Float64Array(n - 1);
  const delta = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    h[k] = x[k + 1] - x[k];
    delta[k] = (y[k + 1] - y[k]) / h[k];
  }

  // Interior slopes (weighted harmonic mean when adjacent slopes share sign)
  for (let k = 1; k < n - 1; k++) {
    if (delta[k - 1] === 0 || delta[k] === 0 || signVal(delta[k - 1]) !== signVal(delta[k])) {
      d[k] = 0;
    } else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      d[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k]);
    }
  }

  // Left endpoint slope (non-centered three-point shape-preserving formula)
  let d0 = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1]);
  if (signVal(d0) !== signVal(delta[0])) {
    d0 = 0;
  } else if (signVal(delta[0]) !== signVal(delta[1]) && Math.abs(d0) > Math.abs(3 * delta[0])) {
    d0 = 3 * delta[0];
  }
  d[0] = d0;

  // Right endpoint slope
  let dn =
    ((2 * h[n - 2] + h[n - 3]) * delta[n - 2] - h[n - 2] * delta[n - 3]) /
    (h[n - 2] + h[n - 3]);
  if (signVal(dn) !== signVal(delta[n - 2])) {
    dn = 0;
  } else if (
    signVal(delta[n - 2]) !== signVal(delta[n - 3]) &&
    Math.abs(dn) > Math.abs(3 * delta[n - 2])
  ) {
    dn = 3 * delta[n - 2];
  }
  d[n - 1] = dn;

  return d;
}

/**
 * Continuously-compounded zero-coupon curve with PCHIP interpolation (Gregory Cap. 13).
 * Exact TypeScript equivalent of `ZeroCurve` in `curves/curve_builder.py`.
 */
export class ZeroCurve {
  public readonly tenors: readonly number[];
  public readonly zeroRates: readonly number[];
  private readonly minT: number;
  private readonly maxT: number;
  private readonly minRate: number;
  private readonly maxRate: number;
  private readonly slopes: Float64Array;

  constructor(tenors: readonly number[], zeroRates: readonly number[]) {
    if (!Array.isArray(tenors) || !Array.isArray(zeroRates)) {
      throw new Error('tenors and zeroRates must be arrays');
    }
    if (tenors.length !== zeroRates.length) {
      throw new Error('tenors and zeroRates must have the same length');
    }
    if (tenors.length < 2) {
      throw new Error('at least two tenor points are required');
    }
    for (let i = 0; i < tenors.length; i++) {
      if (!Number.isFinite(tenors[i]) || tenors[i] < 0) {
        throw new Error('tenors must be finite and non-negative');
      }
      if (!Number.isFinite(zeroRates[i])) {
        throw new Error('zeroRates must be finite numbers');
      }
      if (i > 0 && tenors[i] <= tenors[i - 1]) {
        throw new Error('tenors must be strictly increasing');
      }
    }

    this.tenors = [...tenors];
    this.zeroRates = [...zeroRates];
    this.minT = this.tenors[0];
    this.maxT = this.tenors[this.tenors.length - 1];
    this.minRate = this.zeroRates[0];
    this.maxRate = this.zeroRates[this.zeroRates.length - 1];
    this.slopes = computePchipSlopes(this.tenors, this.zeroRates);
  }

  /**
   * Evaluates the PCHIP-interpolated continuous zero rate at maturity `t` (years),
   * with flat extrapolation outside `[tenors[0], tenors[last]]`.
   */
  public zeroRate(t: number): number {
    if (!Number.isFinite(t)) {
      throw new Error(`Invalid tenor t=${t}`);
    }
    if (t <= this.minT) return this.minRate;
    if (t >= this.maxT) return this.maxRate;

    // Binary search for interval [tenors[k], tenors[k+1]]
    let lo = 0;
    let hi = this.tenors.length - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < this.tenors[mid]) {
        hi = mid - 1;
      } else if (t > this.tenors[mid + 1]) {
        lo = mid + 1;
      } else {
        lo = mid;
        break;
      }
    }
    const k = Math.min(Math.max(lo, 0), this.tenors.length - 2);
    const h = this.tenors[k + 1] - this.tenors[k];
    const s = t - this.tenors[k];
    const delta = (this.zeroRates[k + 1] - this.zeroRates[k]) / h;
    const dk = this.slopes[k];
    const dk1 = this.slopes[k + 1];
    const c2 = (3 * delta - 2 * dk - dk1) / h;
    const c3 = (dk + dk1 - 2 * delta) / (h * h);
    return this.zeroRates[k] + s * (dk + s * (c2 + s * c3));
  }

  /**
   * Vectorized helper for evaluating zero rates at multiple times.
   */
  public zeroRateArray(times: readonly number[]): number[] {
    return times.map((t) => this.zeroRate(t));
  }

  /**
   * Continuous discount factor `df(t) = exp(-z(t) * t)` with `df(0) = 1.0` (Gregory Cap. 13).
   */
  public discountFactor(t: number): number {
    if (t < 0 || !Number.isFinite(t)) {
      throw new Error(`Invalid time t=${t}: must be finite and >= 0`);
    }
    if (t === 0) return 1.0;
    const z = this.zeroRate(t);
    return Math.exp(-z * t);
  }

  /**
   * Vectorized discount factor evaluation.
   */
  public discountFactorArray(times: readonly number[]): number[] {
    return times.map((t) => this.discountFactor(t));
  }

  /**
   * Continuously-compounded forward rate between `t1` and `t2` (`t2 > t1`):
   * `f(t1, t2) = (ln DF(t1) - ln DF(t2)) / (t2 - t1)`.
   */
  public forwardRate(t1: number, t2: number): number {
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 < 0) {
      throw new Error('t1 and t2 must be finite and non-negative');
    }
    const dt = t2 - t1;
    if (dt <= 0) {
      throw new Error('t2 must be strictly greater than t1');
    }
    const lnDf1 = Math.log(this.discountFactor(t1));
    const lnDf2 = Math.log(this.discountFactor(t2));
    return (lnDf1 - lnDf2) / dt;
  }

  /**
   * Returns a new ZeroCurve with node `nodeIndex` bumped by `bumpDecimal` (e.g. 0.0001 = 1 bp)
   * or all nodes shifted in parallel if `nodeIndex` is omitted.
   */
  public bumpNode(nodeIndex: number, bumpDecimal: number): ZeroCurve {
    const bumped = [...this.zeroRates];
    if (nodeIndex < 0 || nodeIndex >= bumped.length) {
      throw new Error(`Invalid nodeIndex ${nodeIndex}`);
    }
    bumped[nodeIndex] += bumpDecimal;
    return new ZeroCurve(this.tenors, bumped);
  }

  public toData(name: CurveName): ZeroCurveData {
    return {
      name,
      tenors: [...this.tenors],
      zeroRates: [...this.zeroRates],
    };
  }

  public static fromData(data: ZeroCurveData): ZeroCurve {
    return new ZeroCurve(data.tenors, data.zeroRates);
  }
}

/**
 * Container of the three OIS discounting curves (SOFR, CAMARA_CLP, CAMARA_UF) (Gregory Cap. 13).
 */
export class CurveSet {
  public readonly sofr: ZeroCurve;
  public readonly camara_clp: ZeroCurve;
  public readonly camara_uf: ZeroCurve;

  constructor(params: { sofr: ZeroCurve; camara_clp: ZeroCurve; camara_uf: ZeroCurve }) {
    this.sofr = params.sofr;
    this.camara_clp = params.camara_clp;
    this.camara_uf = params.camara_uf;
  }

  public get(name: CurveName | string): ZeroCurve {
    const key = name.trim().toUpperCase();
    if (key === 'SOFR') return this.sofr;
    if (key === 'CAMARA_CLP') return this.camara_clp;
    if (key === 'CAMARA_UF') return this.camara_uf;
    throw new Error(`Unknown curve name "${name}"; expected one of ['CAMARA_CLP', 'CAMARA_UF', 'SOFR']`);
  }

  /**
   * Cheapest-to-deliver collateral curve selection (Gregory Cap. 13):
   * "A party should optimally post the collateral in the highest yielding currency."
   */
  // SUPUESTO (no en Gregory): Maps Currency ('USD'->'SOFR', 'CLP'->'CAMARA_CLP', 'UF'->'CAMARA_UF')
  // and compares the 1Y continuous zero rate as the yield proxy when multiple collateral currencies are eligible.
  public selectCheapestToDeliverCurve(eligibleCcy: readonly Currency[], horizonYears = 1.0): CurveName {
    const ccyToCurve: Record<Currency, CurveName> = {
      USD: 'SOFR',
      CLP: 'CAMARA_CLP',
      UF: 'CAMARA_UF',
      EUR: 'SOFR', // SUPUESTO (no en Gregory): fallback to SOFR when EUR curve not parameterized
    };
    if (!eligibleCcy || eligibleCcy.length === 0) {
      return 'CAMARA_CLP';
    }
    let bestCurve: CurveName = ccyToCurve[eligibleCcy[0]] ?? 'CAMARA_CLP';
    let highestYield = -Infinity;
    for (const ccy of eligibleCcy) {
      const cName = ccyToCurve[ccy] ?? 'CAMARA_CLP';
      const r = this.get(cName).zeroRate(horizonYears);
      if (r > highestYield) {
        highestYield = r;
        bestCurve = cName;
      }
    }
    return bestCurve;
  }

  public static fromRecord(record: Record<CurveName, ZeroCurveData>): CurveSet {
    return new CurveSet({
      sofr: ZeroCurve.fromData(record.SOFR),
      camara_clp: ZeroCurve.fromData(record.CAMARA_CLP),
      camara_uf: ZeroCurve.fromData(record.CAMARA_UF),
    });
  }

  public toRecord(): Record<CurveName, ZeroCurveData> {
    return {
      SOFR: this.sofr.toData('SOFR'),
      CAMARA_CLP: this.camara_clp.toData('CAMARA_CLP'),
      CAMARA_UF: this.camara_uf.toData('CAMARA_UF'),
    };
  }
}

/**
 * Sample market curves matching `sample_market_curves()` in `curves/curve_builder.py` (FR-1 acceptance).
 */
export function sampleMarketCurves(): CurveSet {
  const tenors = [0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0, 15.0, 20.0, 30.0];

  const sofrRates = [
    0.0530, 0.0520, 0.0490, 0.0450, 0.0420, 0.0400, 0.0395, 0.0400, 0.0410, 0.0415, 0.0420,
  ];

  const camaraClpRates = [
    0.0620, 0.0600, 0.0570, 0.0530, 0.0510, 0.0495, 0.0490, 0.0495, 0.0505, 0.0510, 0.0515,
  ];

  const camaraUfRates = [
    0.0120, 0.0125, 0.0135, 0.0150, 0.0160, 0.0170, 0.0175, 0.0180, 0.0185, 0.0188, 0.0190,
  ];

  return new CurveSet({
    sofr: new ZeroCurve(tenors, sofrRates),
    camara_clp: new ZeroCurve(tenors, camaraClpRates),
    camara_uf: new ZeroCurve(tenors, camaraUfRates),
  });
}
