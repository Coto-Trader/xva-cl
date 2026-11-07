/**
 * Credit Curve & Hazard Rate Bootstrap (Fase 2 — src/engine/credit.ts)
 *
 * Faithful to Jon Gregory, "The xVA Challenge" (3rd ed., 2015), Chapter 12:
 * - Risk-neutral default probabilities derived from credit spreads (Gregory Cap. 12, IFRS 13):
 *   "regulators and auditors generally do not support the deviation from risk-neutral default probabilities"
 * - Credit triangle approximation: lambda ≈ s / LGD, where LGD = 1 - recoveryRate (Cap. 12).
 * - Piecewise-constant marginal hazard rate curve bootstrapped across tenors up to portfolio maturity:
 *   "define fully the term structure of credit spreads up to the maturity" (Cap. 12).
 * - Mandatory proxy mapping by (rating, sector, region) for illiquid counterparties without CDS (Cap. 12).
 * - Explicit rejection of inverted CDS curves that imply negative marginal hazard rates (distressed names).
 */

import { Counterparty, CreditCurveData, ProxyKey, Rating } from '../domain/types';

/**
 * Single-tenor credit triangle bootstrap: `lambda = cdsSpread / (1 - recoveryRate)` (Gregory Cap. 12).
 * Exact equivalent of `bootstrap_hazard_rate` in `xva/credit.py`.
 */
export function bootstrapHazardRate(cdsSpread: number, recoveryRate: number): number {
  if (!Number.isFinite(recoveryRate) || recoveryRate < 0 || recoveryRate >= 1.0) {
    throw new Error('recovery_rate must be in [0, 1.0) (LGD would be non-positive)');
  }
  if (!Number.isFinite(cdsSpread) || cdsSpread < 0) {
    throw new Error('cds_spread must be finite and non-negative');
  }
  const lgd = 1.0 - recoveryRate;
  return cdsSpread / lgd;
}

/**
 * Survival probability under constant hazard intensity: `S(t) = exp(-hazardRate * t)` (Gregory Cap. 12).
 */
export function survivalProbability(hazardRate: number, t: number): number {
  if (t < 0 || !Number.isFinite(t)) {
    throw new Error('t must be finite and non-negative');
  }
  return Math.exp(-hazardRate * t);
}

/**
 * Marginal default probability on `[t0, t1]` (`t1 > t0`): `PD(t0, t1) = S(t0) - S(t1)` (Gregory Cap. 12).
 */
export function marginalDefaultProbability(hazardRate: number, t0: number, t1: number): number {
  if (t1 <= t0) {
    throw new Error('t1 must be greater than t0');
  }
  return survivalProbability(hazardRate, t0) - survivalProbability(hazardRate, t1);
}

/**
 * Piecewise-constant hazard curve bootstrapped from a CDS term structure (Gregory Cap. 12).
 */
export interface HazardCurve {
  readonly tenors: readonly number[];
  readonly cdsSpreads: readonly number[];
  readonly recoveryRate: number;
  readonly lgd: number;
  readonly marginalRates: readonly number[];
  /** Piecewise-constant hazard intensity `lambda(t)` matching `credit.py`. */
  hazardRateAt(t: number): number;
  /** Integrated cumulative hazard `H(t) = \int_0^t lambda(u) du`. */
  cumulativeHazard(t: number): number;
  /** Risk-neutral survival probability `S(t) = exp(-H(t))`. */
  survivalProbability(t: number): number;
  /** Marginal default probability `S(t0) - S(t1)` over `[t0, t1]`. */
  marginalDefaultProbability(t0: number, t1: number): number;
}

/**
 * Bootstraps a piecewise-constant marginal hazard curve from tenors and par CDS spreads.
 * Matches `bootstrap_hazard_curve` in `xva/credit.py` and rejects inverted curves that
 * produce negative marginal hazard rates (FR-2.1, FR-2.3, Gregory Cap. 12).
 */
export function bootstrapHazardCurve(
  tenors: readonly number[],
  cdsSpreads: readonly number[],
  recoveryRate: number
): HazardCurve {
  if (!Number.isFinite(recoveryRate) || recoveryRate < 0 || recoveryRate >= 1.0) {
    throw new Error('recovery_rate must be < 1.0 (LGD would be non-positive)');
  }
  if (!Array.isArray(tenors) || !Array.isArray(cdsSpreads)) {
    throw new Error('tenors and cds_spreads must be arrays');
  }
  if (tenors.length !== cdsSpreads.length) {
    throw new Error('tenors and cds_spreads must have the same shape');
  }
  if (tenors.length === 0) {
    throw new Error('tenors must be non-empty');
  }
  if (tenors[0] <= 0) {
    throw new Error('first tenor must be strictly positive');
  }
  for (let i = 0; i < tenors.length; i++) {
    if (!Number.isFinite(tenors[i]) || !Number.isFinite(cdsSpreads[i]) || cdsSpreads[i] < 0) {
      throw new Error('tenors and cds_spreads must be finite non-negative numbers');
    }
    if (i > 0 && tenors[i] <= tenors[i - 1]) {
      throw new Error('tenors must be strictly increasing');
    }
  }

  const lgd = 1.0 - recoveryRate;
  const n = tenors.length;
  const cumulativeHazards = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const avgLambda = cdsSpreads[i] / lgd;
    cumulativeHazards[i] = avgLambda * tenors[i];
  }

  const marginalRates = new Float64Array(n);
  marginalRates[0] = cumulativeHazards[0] / tenors[0];
  for (let i = 1; i < n; i++) {
    marginalRates[i] =
      (cumulativeHazards[i] - cumulativeHazards[i - 1]) / (tenors[i] - tenors[i - 1]);
  }

  for (let i = 0; i < n; i++) {
    if (marginalRates[i] < 0) {
      throw new Error(
        `bootstrap produced a negative hazard rate in bucket ${i} (tenor ${tenors[i]}); ` +
          `this indicates an inverted CDS spread curve that the flat-average-hazard bootstrap ` +
          `cannot represent as a valid (non-negative) piecewise-constant intensity (Gregory Cap. 12)`
      );
    }
  }

  const tenorsCopy = [...tenors];
  const spreadsCopy = [...cdsSpreads];
  const marginalCopy = Array.from(marginalRates);

  function hazardRateAt(t: number): number {
    if (t <= tenorsCopy[0]) {
      return marginalCopy[0];
    }
    // Equivalent to np.searchsorted(tenors, t, side="left"):
    // smallest index idx such that tenors[idx] >= t
    for (let idx = 0; idx < n; idx++) {
      if (tenorsCopy[idx] >= t) {
        return marginalCopy[idx];
      }
    }
    return marginalCopy[n - 1];
  }

  function cumulativeHazard(t: number): number {
    if (t < 0 || !Number.isFinite(t)) {
      throw new Error('t must be finite and non-negative');
    }
    if (t === 0) return 0;

    let integral = 0;
    let prevT = 0;
    for (let i = 0; i < n; i++) {
      const bucketEnd = tenorsCopy[i];
      if (t <= bucketEnd) {
        integral += marginalCopy[i] * (t - prevT);
        return integral;
      }
      integral += marginalCopy[i] * (bucketEnd - prevT);
      prevT = bucketEnd;
    }
    // Beyond last tenor: extrapolate flat with last marginal hazard rate
    integral += marginalCopy[n - 1] * (t - prevT);
    return integral;
  }

  function survivalProbAt(t: number): number {
    return Math.exp(-cumulativeHazard(t));
  }

  function marginalPd(t0: number, t1: number): number {
    if (t1 <= t0) {
      throw new Error('t1 must be greater than t0');
    }
    return survivalProbAt(t0) - survivalProbAt(t1);
  }

  return {
    tenors: tenorsCopy,
    cdsSpreads: spreadsCopy,
    recoveryRate,
    lgd,
    marginalRates: marginalCopy,
    hazardRateAt,
    cumulativeHazard,
    survivalProbability: survivalProbAt,
    marginalDefaultProbability: marginalPd,
  };
}

/**
 * Base 5Y proxy CDS spreads (in decimal, e.g. 0.0150 = 150 bps) by rating,
 * plus sector and region multipliers.
 * Gregory Cap. 12: "the bank must use a proxy spread that is appropriate
 * based on the rating, industry and region."
 * // SUPUESTO (no en Gregory): Exact numerical lookup table for rating/sector/region
 * // spreads and term-structure slope factors calibrated to LatAm/Chile OTC benchmarks.
 */
const BASE_5Y_SPREAD_BY_RATING: Record<Rating, number> = {
  AAA: 0.0030,
  AA: 0.0050,
  A: 0.0080,
  BBB: 0.0150,
  BB: 0.0280,
  B: 0.0480,
  CCC: 0.0850,
  NR: 0.0220,
};

const SECTOR_MULTIPLIER: Record<string, number> = {
  sovereign: 0.80,
  bank: 0.95,
  financial: 1.00,
  utilities: 0.95,
  corporate: 1.00,
  mining: 1.05,
  retail: 1.15,
  realestate: 1.20,
};

const REGION_MULTIPLIER: Record<string, number> = {
  dm: 0.85,
  us: 0.85,
  eu: 0.90,
  chile: 1.00,
  latam: 1.20,
  em: 1.25,
};

const PROXY_TENORS: readonly number[] = [1, 2, 3, 5, 7, 10];
// Upward-sloping normal credit term structure multipliers around 5Y (= 1.00)
// // SUPUESTO (no en Gregory): Standard upward-sloping term structure shape for proxy curves
const PROXY_SLOPE_FACTORS: readonly number[] = [0.65, 0.78, 0.88, 1.00, 1.08, 1.15];

/**
 * Generates a complete proxy CreditCurveData from `(rating, sector, region)` (Gregory Cap. 12, FR-2.2).
 */
export function buildProxyCreditCurve(proxyKey: ProxyKey, recoveryRate = 0.40): CreditCurveData {
  if (!proxyKey || !proxyKey.rating || !proxyKey.sector?.trim() || !proxyKey.region?.trim()) {
    throw new Error('ProxyKey must include valid rating, sector, and region (Gregory Cap. 12).');
  }
  const base5Y = BASE_5Y_SPREAD_BY_RATING[proxyKey.rating] ?? 0.0150;
  const secKey = proxyKey.sector.trim().toLowerCase().replace(/\s+/g, '');
  const regKey = proxyKey.region.trim().toLowerCase().replace(/\s+/g, '');
  const secMult = SECTOR_MULTIPLIER[secKey] ?? 1.00;
  const regMult = REGION_MULTIPLIER[regKey] ?? 1.00;

  const spread5Y = base5Y * secMult * regMult;
  const cdsSpreads = PROXY_SLOPE_FACTORS.map((m) => +(spread5Y * m).toFixed(6));

  return {
    tenors: [...PROXY_TENORS],
    cdsSpreads,
    recoveryRate,
  };
}

/**
 * Resolves a Counterparty's effective CreditCurveData (direct CDS if present, otherwise ProxyKey)
 * and bootstraps its piecewise-constant HazardCurve (Gregory Cap. 12, FR-2.1, FR-2.2, FR-2.3).
 */
export function resolveCounterpartyCreditCurve(counterparty: Counterparty): CreditCurveData {
  if (counterparty.creditCurve && counterparty.creditCurve.tenors.length > 0) {
    return counterparty.creditCurve;
  }
  if (counterparty.proxyKey) {
    return buildProxyCreditCurve(counterparty.proxyKey, counterparty.recoveryRate);
  }
  throw new Error(
    `Counterparty "${counterparty.name}" lacks both creditCurve and proxyKey (Gregory Cap. 12 / FR-2.2).`
  );
}

export function resolveCounterpartyHazardCurve(counterparty: Counterparty): HazardCurve {
  const curveData = resolveCounterpartyCreditCurve(counterparty);
  return bootstrapHazardCurve(curveData.tenors, curveData.cdsSpreads, curveData.recoveryRate);
}
