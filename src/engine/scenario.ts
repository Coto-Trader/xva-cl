/**
 * Monte Carlo Pathwise Scenario Generator (Fase 3 — src/engine/scenario.ts)
 *
 * Faithful to "The xVA Challenge" (3rd ed., 2015), Chapters 7 & 10:
 * - "exposure needs to be defined over multiple time horizons" (Cap. 7).
 * - "the simulation model must be generic to support consistent simulation of the many risk factors" (Cap. 10).
 * - "the pathwise method is more suitable for path-dependent derivatives... collateral modelling" (Cap. 10).
 * - "Models must obviously not be too complex" (Cap. 10 — parsimony principle).
 * - Deterministic PRNG seeded by `mc.seed` (NFR-3).
 */

import { CurveName, MarketEnv, MonteCarloConfig } from '../domain/types';
import { CurveSet } from './curves';

/**
 * Mulberry32 deterministic 32-bit PRNG returning uniform [0, 1) numbers.
 * Ensures exact cross-platform reproducibility for a given `seed` (NFR-3).
 */
export class DeterministicRNG {
  private state: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    this.state = (Math.floor(seed) | 0) || 1;
  }

  public nextUniform(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Standard normal variate Z ~ N(0, 1) via polar Box-Muller transform.
   */
  public nextNormal(): number {
    if (this.spareNormal !== null) {
      const val = this.spareNormal;
      this.spareNormal = null;
      return val;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    while (s === 0 || s >= 1) {
      u = this.nextUniform() * 2 - 1;
      v = this.nextUniform() * 2 - 1;
      s = u * u + v * v;
    }
    const mul = Math.sqrt((-2.0 * Math.log(s)) / s);
    this.spareNormal = v * mul;
    return u * mul;
  }
}

export interface SimulatedPathPoint {
  /** Time in years from valuation date. */
  t: number;
  /** Interval length dt = t_k - t_{k-1} in years. */
  dt: number;
  /** Standard Brownian motion value W_fx(t) ~ N(0, t) driving UF/CLP index risk. */
  brownianFx: number;
  /** Standard normal equivalent Z(t) = W_fx(t) / sqrt(t) (0 at t=0). */
  stdNormalFx: number;
  /** Simulated UF/CLP FX rate at time t along this path. */
  ufClpSpot: number;
  /** Simulated parallel zero-rate shock (in decimal) by curve name. */
  rateShock: Record<CurveName, number>;
}

export interface SimulationGrid {
  /** Time grid points in years: [t_1, t_2, ..., t_M] (strictly positive bucket ends). */
  readonly bucketTimes: readonly number[];
  /** Bucket start times in years: [0, t_1, ..., t_{M-1}]. */
  readonly bucketStarts: readonly number[];
  /** Step sizes dt_k = bucketTimes[k] - bucketStarts[k]. */
  readonly dt: readonly number[];
  /** Number of Monte Carlo paths N. */
  readonly numPaths: number;
  /** Seed used to generate the paths. */
  readonly seed: number;
  /**
   * Pathwise state matrix indexed as `paths[pathIdx][timeIdx]`, where
   * `timeIdx` corresponds to `bucketTimes[timeIdx]`.
   */
  readonly paths: readonly (readonly SimulatedPathPoint[])[];
}

/**
 * Builds the time grid up to `maxMaturityYears` (Cap. 10: last grid point >= longest maturity)
 * and simulates `mc.numPaths` correlated/consistent risk-factor trajectories.
 */
export function generateMonteCarloScenarios(
  market: MarketEnv,
  curves: CurveSet,
  mc: MonteCarloConfig,
  maxMaturityYears: number
): SimulationGrid {
  const horizon = Math.max(maxMaturityYears, 0.25);
  const stepsPerYear = Math.max(1, Math.min(mc.gridPointsPerYear, 100));
  const totalBuckets = Math.max(2, Math.min(Math.round(horizon * stepsPerYear), 200));
  const dtStep = horizon / totalBuckets;

  const bucketStarts: number[] = [];
  const bucketTimes: number[] = [];
  const dt: number[] = [];

  for (let k = 0; k < totalBuckets; k++) {
    const t0 = +(k * dtStep).toFixed(8);
    const t1 = +((k + 1) * dtStep).toFixed(8);
    bucketStarts.push(t0);
    bucketTimes.push(t1);
    dt.push(+(t1 - t0).toFixed(8));
  }

  const rng = new DeterministicRNG(mc.seed);
  const spot0 = market.fxSpot.UFCLP ?? 38_000;
  const volFx = market.fxVol.UFCLP ?? 0.10;
  const volSofr = market.rateVol?.SOFR ?? 0.0060;
  const volClp = market.rateVol?.CAMARA_CLP ?? 0.0075;
  const volUf = market.rateVol?.CAMARA_UF ?? 0.0050;

  // Use antithetic variates on paired paths so sample mean E[W_t] = 0 and
  // sample E[|Z|] converges rapidly to sqrt(2/pi) (Cap. 10 variance reduction).
  // // SUPUESTO (no en ): Antithetic pairing enabled by default for faster MC convergence in browser.
  const paths: SimulatedPathPoint[][] = [];
  const numPaths = Math.max(2, mc.numPaths);

  for (let p = 0; p < numPaths; p += 2) {
    const pathPos: SimulatedPathPoint[] = [];
    const pathNeg: SimulatedPathPoint[] = [];
    let wFx = 0;
    let wRateSofr = 0;
    let wRateClp = 0;
    let wRateUf = 0;

    for (let k = 0; k < totalBuckets; k++) {
      const t = bucketTimes[k];
      const stepDt = dt[k];
      const sqrtDt = Math.sqrt(stepDt);

      const zFx = rng.nextNormal();
      const zRate = rng.nextNormal();

      wFx += zFx * sqrtDt;
      wRateSofr += zRate * sqrtDt;
      wRateClp += (0.6 * zFx + 0.8 * zRate) * sqrtDt;
      wRateUf += (0.5 * zFx + Math.sqrt(0.75) * zRate) * sqrtDt;

      const sqrtT = Math.sqrt(Math.max(t, 1e-8));
      const fwdRatio =
        curves.camara_uf.discountFactor(t) / Math.max(curves.camara_clp.discountFactor(t), 1e-12);
      const fwdFx = spot0 * fwdRatio;

      const ufClpPos = fwdFx * Math.exp(-0.5 * volFx * volFx * t + volFx * wFx);
      const ufClpNeg = fwdFx * Math.exp(-0.5 * volFx * volFx * t - volFx * wFx);

      pathPos.push({
        t,
        dt: stepDt,
        brownianFx: wFx,
        stdNormalFx: wFx / sqrtT,
        ufClpSpot: ufClpPos,
        rateShock: {
          SOFR: volSofr * wRateSofr,
          CAMARA_CLP: volClp * wRateClp,
          CAMARA_UF: volUf * wRateUf,
        },
      });

      pathNeg.push({
        t,
        dt: stepDt,
        brownianFx: -wFx,
        stdNormalFx: -wFx / sqrtT,
        ufClpSpot: ufClpNeg,
        rateShock: {
          SOFR: -volSofr * wRateSofr,
          CAMARA_CLP: -volClp * wRateClp,
          CAMARA_UF: -volUf * wRateUf,
        },
      });
    }

    paths.push(pathPos);
    if (paths.length < numPaths) {
      paths.push(pathNeg);
    }
  }

  return {
    bucketTimes,
    bucketStarts,
    dt,
    numPaths: paths.length,
    seed: mc.seed,
    paths,
  };
}
