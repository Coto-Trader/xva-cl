/**
 * Derivative Product Pricers & Analytical Reference Profile (Fase 3 — src/engine/pricing.ts)
 *
 * Faithful to "The xVA Challenge" (3rd ed., 2015), Chapters 7, 10 & 13:
 * - Ageing / roll-off of transactions over time (Cap. 7).
 * - Pathwise MTM valuation across the simulation grid (Cap. 10).
 * - Reproduces the reference diffusion profile and fixed-cashflow PV of `demo.py` and `sensitivities/aad.py`.
 */

import { AnyTrade, CCSUFCLPTrade, FXForwardTrade, IRSTrade, MarketEnv } from '../domain/types';
import { CurveSet } from './curves';
import { SimulatedPathPoint } from './scenario';

export interface CashflowItem {
  timeYears: number;
  amount: number;
  currency: 'UF' | 'CLP' | 'USD' | 'EUR';
}

/**
 * Generates the contractual cashflow schedule for a trade (Cap. 7 & Cap. 10).
 */
export function generateTradeCashflows(trade: AnyTrade): CashflowItem[] {
  const nCoupons = Math.max(1, Math.ceil(trade.maturityYears));
  const dt = trade.maturityYears / nCoupons;
  const sign = trade.direction === 'RECEIVE' ? 1 : -1;
  const flows: CashflowItem[] = [];

  if (trade.product === 'CCS_UF_CLP') {
    const ccs = trade as CCSUFCLPTrade;
    const ufRate = ccs.ufFixedRate ?? 0.025;
    for (let i = 1; i <= nCoupons; i++) {
      const t = +(i * dt).toFixed(6);
      const isFinal = i === nCoupons;
      const couponUF = ccs.notionalUF * ufRate * dt;
      const principalUF = isFinal ? ccs.notionalUF : 0;
      flows.push({
        timeYears: t,
        amount: sign * (couponUF + principalUF),
        currency: 'UF',
      });
    }
    return flows;
  }

  for (let i = 1; i <= nCoupons; i++) {
    const t = +(i * dt).toFixed(6);
    const isFinal = i === nCoupons;
    flows.push({
      timeYears: t,
      amount: sign * trade.notional * (isFinal ? 1.05 : 0.05 * dt),
      currency: trade.currency,
    });
  }
  return flows;
}

/**
 * Prices a deterministic vector of cashflows using linear interpolation on `zeroRates`
 * and `exp(-z(t)*t)` discounting, reproducing `price_fixed_cashflows` in `sensitivities/aad.py`.
 */
export function priceFixedCashflowsLinear(
  zeroRates: readonly number[],
  tenors: readonly number[],
  cashflowTimes: readonly number[],
  cashflowAmounts: readonly number[]
): number {
  if (zeroRates.length !== tenors.length) {
    throw new Error(`zeroRates.length (${zeroRates.length}) != tenors.length (${tenors.length})`);
  }
  if (cashflowTimes.length !== cashflowAmounts.length) {
    throw new Error(
      `cashflowTimes.length (${cashflowTimes.length}) != cashflowAmounts.length (${cashflowAmounts.length})`
    );
  }
  const minT = tenors[0];
  const maxT = tenors[tenors.length - 1];

  let pv = 0;
  for (let m = 0; m < cashflowTimes.length; m++) {
    const t = cashflowTimes[m];
    const tClipped = Math.min(Math.max(t, minT), maxT);

    // Piecewise-linear interpolation matching jnp.interp(t_clipped, tenors, zero_rates)
    let z = zeroRates[0];
    if (tClipped <= minT) {
      z = zeroRates[0];
    } else if (tClipped >= maxT) {
      z = zeroRates[zeroRates.length - 1];
    } else {
      for (let k = 0; k < tenors.length - 1; k++) {
        if (tClipped >= tenors[k] && tClipped <= tenors[k + 1]) {
          const w = (tClipped - tenors[k]) / (tenors[k + 1] - tenors[k]);
          z = zeroRates[k] + w * (zeroRates[k + 1] - zeroRates[k]);
          break;
        }
      }
    }
    const df = Math.exp(-z * t);
    pv += cashflowAmounts[m] * df;
  }
  return pv;
}

/**
 * Pathwise mark-to-market valuation `V(t)` in UF terms for a trade at simulation step `point`
 * (Cap. 7 & Cap. 10).
 *
 * For `CCS_UF_CLP`:
 * - Incorporates initial FX mark-to-market (`(ufClpFxFixed - spot0) / spot0`) plus the
 *   diffusion innovation `notionalUF * sigma * W_fx(t)` consistent with `demo.py`'s
 *   `build_expected_exposure_profile`:
 *     `MtM(t) ~ notional_uf * sigma * sqrt(t) * Z, Z ~ N(0, 1)`
 *   plus interest-rate differential sensitivity from `point.rateShock`.
 */
export function priceTradePathwiseUF(
  trade: AnyTrade,
  market: MarketEnv,
  _curves: CurveSet,
  point: SimulatedPathPoint
): number {
  // Roll-off after trade maturity (Cap. 7: ageing of transactions)
  if (point.t > trade.maturityYears + 1e-9) {
    return 0.0;
  }

  const sign = trade.direction === 'RECEIVE' ? 1.0 : -1.0;
  const volFx = market.fxVol.UFCLP ?? 0.10;
  const spot0 = market.fxSpot.UFCLP ?? 38_000;

  if (trade.product === 'CCS_UF_CLP') {
    const ccs = trade as CCSUFCLPTrade;
    const fxStrikeShift = ((ccs.ufClpFxFixed - spot0) / Math.max(spot0, 1)) * ccs.notionalUF;
    const remainingYears = Math.max(ccs.maturityYears - point.t, 0);
    const rateDiffShock =
      ((point.rateShock.CAMARA_CLP ?? 0) - (point.rateShock.CAMARA_UF ?? 0)) *
      remainingYears *
      0.25 *
      ccs.notionalUF;

    // Core diffusion term matching demo.py: notional_uf * sigma * W_fx(t)
    const diffusionUF = ccs.notionalUF * volFx * point.brownianFx;
    return sign * (fxStrikeShift + diffusionUF + rateDiffShock);
  }

  if (trade.product === 'IRS') {
    const irs = trade as IRSTrade;
    const curveKey = irs.floatCurve ?? 'CAMARA_CLP';
    const rShock = point.rateShock[curveKey] ?? 0;
    const rem = Math.max(irs.maturityYears - point.t, 0.25);
    const notionalUF = irs.currency === 'UF' ? irs.notional : irs.notional / Math.max(spot0, 1);
    return sign * notionalUF * (-rShock * rem + 0.5 * volFx * point.brownianFx);
  }

  const fxf = trade as FXForwardTrade;
  const notionalUF = fxf.currency === 'UF' ? fxf.notional : fxf.notional / Math.max(spot0, 1);
  const strikeShift = ((fxf.strikeFx - spot0) / Math.max(spot0, 1)) * notionalUF;
  return sign * (strikeShift + notionalUF * volFx * point.brownianFx);
}

/**
 * Analytical diffusion-based expected exposure profile reproducing `build_expected_exposure_profile`
 * in `demo.py` (lines 64-90) with exact floating-point agreement.
 */
export interface AnalyticalExposureProfile {
  bucketStarts: number[];
  bucketTimes: number[];
  expectedExposure: number[];
  expectedNegativeExposure: number[];
  discountFactors: number[];
  dt: number[];
}

export function buildAnalyticalCCSExposureProfile(
  curves: CurveSet,
  trade: Pick<CCSUFCLPTrade, 'notionalUF' | 'maturityYears'>,
  annualizedUfClpVol = 0.10,
  nBuckets = 10
): AnalyticalExposureProfile {
  const dtBucket = trade.maturityYears / nBuckets;
  const bucketStarts: number[] = [];
  const bucketTimes: number[] = [];
  const expectedExposure: number[] = [];
  const expectedNegativeExposure: number[] = [];
  const discountFactors: number[] = [];
  const dt: number[] = [];

  const halfFoldedNormal = 0.5 * Math.sqrt(2.0 / Math.PI);

  for (let i = 0; i < nBuckets; i++) {
    const t0 = i * dtBucket;
    const t1 = (i + 1) * dtBucket;
    const expectedAbsMtm = trade.notionalUF * annualizedUfClpVol * Math.sqrt(t1);
    const ee = halfFoldedNormal * expectedAbsMtm;
    const df = curves.camara_uf.discountFactor(t1);

    bucketStarts.push(t0);
    bucketTimes.push(t1);
    expectedExposure.push(ee);
    expectedNegativeExposure.push(ee);
    discountFactors.push(df);
    dt.push(t1 - t0);
  }

  return {
    bucketStarts,
    bucketTimes,
    expectedExposure,
    expectedNegativeExposure,
    discountFactors,
    dt,
  };
}
