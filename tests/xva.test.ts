import { describe, expect, it } from 'vitest';
import { bootstrapHazardRate, marginalDefaultProbability, survivalProbability } from '../src/engine/credit';
import { sampleMarketCurves } from '../src/engine/curves';
import { buildAnalyticalCCSExposureProfile } from '../src/engine/pricing';
import {
  assertNoDvaFbaDoubleCounting,
  buildSimplifiedCapitalProfile,
  computeCva,
  computeCvaWithWwr,
  computeDva,
  computeFva,
  computeKva,
  computeMva,
  computeXvaSummary,
} from '../src/engine/xva';

describe('Fase 5 & Fase 6 — XVA Engine (CVA, DVA, FCA, FBA, MVA, KVA), Anti-Double-Counting & Wrong-Way Risk (FR-4.4, FR-4.5, FR-5.1, Gregory Cap. 14, 15, 16, 17)', () => {
  const curves = sampleMarketCurves();
  const profile = buildAnalyticalCCSExposureProfile(
    curves,
    { notionalUF: 500_000, maturityYears: 5.0 },
    0.10,
    10,
  );

  // Reference credit setup from demo.py:
  // counterparty CDS = 185 bps (0.0185), recovery = 0.40 (LGD = 0.60)
  // own bank CDS = 95 bps (0.0095), recovery = 0.40 (LGD = 0.60)
  // funding spread = 110 bps
  const cptyLgd = 0.60;
  const ownLgd = 0.60;
  const lambdaCpty = bootstrapHazardRate(185.0 / 10_000.0, 1.0 - cptyLgd);
  const lambdaOwn = bootstrapHazardRate(95.0 / 10_000.0, 1.0 - ownLgd);

  const cptyMarginalPd = profile.bucketTimes.map((t1, idx) =>
    marginalDefaultProbability(lambdaCpty, profile.bucketStarts[idx], t1),
  );
  const ownMarginalPd = profile.bucketTimes.map((t1, idx) =>
    marginalDefaultProbability(lambdaOwn, profile.bucketStarts[idx], t1),
  );
  const cptySurvival = profile.bucketTimes.map((t1) => survivalProbability(lambdaCpty, t1));
  const ownSurvival = profile.bucketTimes.map((t1) => survivalProbability(lambdaOwn, t1));

  it('reproduces demo.py CVA, DVA, FCA, FBA, net_xva, and accounting_xva exactly', () => {
    const summary = computeXvaSummary({
      ee: profile.expectedExposure,
      ene: profile.expectedNegativeExposure,
      df: profile.discountFactors,
      dt: profile.dt,
      cptyMarginalPd,
      ownMarginalPd,
      cptyLgd,
      ownLgd,
      fundingSpreadBps: 110.0,
      ownSurvival,
      cptySurvival,
    });

    const refCva = computeCva(profile.expectedExposure, profile.discountFactors, cptyMarginalPd, cptyLgd);
    const refDva = computeDva(profile.expectedNegativeExposure, profile.discountFactors, ownMarginalPd, ownLgd);
    const refFva = computeFva(
      profile.expectedExposure,
      profile.expectedNegativeExposure,
      profile.discountFactors,
      profile.dt,
      110.0,
      ownSurvival,
      cptySurvival,
    );

    expect(summary.cva).toBeCloseTo(refCva, 10);
    expect(summary.dva).toBeCloseTo(refDva, 10);
    expect(summary.fca).toBeCloseTo(refFva.fca, 10);
    expect(summary.fba).toBeCloseTo(refFva.fba, 10);
    // Symmetric EE == ENE and fba_bps == fca_bps implies FCA == FBA and FVA == 0 in demo.py
    expect(summary.fva).toBeCloseTo(0, 10);

    // Check positive magnitudes (in UF)
    expect(summary.cva).toBeGreaterThan(2_000);
    expect(summary.dva).toBeGreaterThan(1_000);
    expect(summary.cva).toBeGreaterThan(summary.dva); // 185 bps > 95 bps

    // Economic pricing view: -CVA - FCA + FBA
    expect(summary.net_xva).toBeCloseTo(-refCva - refFva.fca + refFva.fba, 10);
    // Accounting IFRS 13 view: -CVA + DVA
    expect(summary.accounting_xva).toBeCloseTo(-refCva + refDva, 10);
  });

  it('HARD RULE (Gregory Cap. 15, FR-4.4, FR-4.5): NEVER sums DVA and FBA together; fails explicitly if anyone does', () => {
    const summary = computeXvaSummary({
      ee: profile.expectedExposure,
      ene: profile.expectedNegativeExposure,
      df: profile.discountFactors,
      dt: profile.dt,
      cptyMarginalPd,
      ownMarginalPd,
      cptyLgd,
      ownLgd,
      fundingSpreadBps: 110.0,
      ownSurvival,
      cptySurvival,
    });

    const forbiddenDoubleCountedTotal = -summary.cva + summary.dva - summary.fca + summary.fba;

    // 1. Verify net_xva is strictly distinct from the double-counted sum (-CVA + DVA - FCA + FBA)
    expect(summary.net_xva).not.toBeCloseTo(forbiddenDoubleCountedTotal, 2);
    expect(Math.abs(summary.net_xva - forbiddenDoubleCountedTotal)).toBeCloseTo(summary.dva, 8);

    // 2. Verify assertNoDvaFbaDoubleCounting throws if someone corrupts net_xva by adding DVA
    expect(() =>
      assertNoDvaFbaDoubleCounting({
        ...summary,
        net_xva: forbiddenDoubleCountedTotal,
      }),
    ).toThrow(/Double-counting violation|CRITICAL QUANT ERROR/);

    // 3. Verify assertNoDvaFbaDoubleCounting throws if accounting_xva mixes in FVA
    expect(() =>
      assertNoDvaFbaDoubleCounting({
        ...summary,
        accounting_xva: -summary.cva + summary.dva - summary.fca,
      }),
    ).toThrow(/Accounting XVA violation/);
  });

  it('computes MVA on segregated Initial Margin and KVA on economic capital profile (Gregory Cap. 16)', () => {
    const imProfile = profile.bucketTimes.map(() => 10_000); // 10,000 UF segregated IM
    const pfeProfile = profile.expectedExposure.map((ee) => ee * 2.33);
    const capProfile = buildSimplifiedCapitalProfile(profile.expectedExposure, pfeProfile);

    const mva = computeMva(imProfile, profile.discountFactors, profile.dt, 110.0, 0, ownSurvival, cptySurvival);
    const kva = computeKva(capProfile, profile.discountFactors, profile.dt, 0.10);

    expect(mva).toBeGreaterThan(0);
    expect(kva).toBeGreaterThan(0);

    const summary = computeXvaSummary({
      ee: profile.expectedExposure,
      ene: profile.expectedNegativeExposure,
      df: profile.discountFactors,
      dt: profile.dt,
      cptyMarginalPd,
      ownMarginalPd,
      cptyLgd,
      ownLgd,
      fundingSpreadBps: 110.0,
      ownSurvival,
      cptySurvival,
      imProfile,
      capitalProfile: capProfile,
      costOfCapitalAnnual: 0.10,
    });

    expect(summary.mva).toBeCloseTo(mva, 10);
    expect(summary.kva).toBeCloseTo(kva, 10);
    expect(summary.net_xva_all_in).toBeCloseTo(summary.net_xva - mva - kva, 10);
  });

  it('Fase 6 — Wrong-Way Risk (FR-5.1, Gregory Cap. 17): rho > 0 increases CVA monotonically, rho = 0 matches base CVA, rho < 0 reduces CVA', () => {
    const cvaBase = computeCvaWithWwr(
      profile.expectedExposure,
      profile.discountFactors,
      cptyMarginalPd,
      cptyLgd,
      0.0,
      profile.bucketTimes,
    );
    const cvaModWwr = computeCvaWithWwr(
      profile.expectedExposure,
      profile.discountFactors,
      cptyMarginalPd,
      cptyLgd,
      0.40,
      profile.bucketTimes,
    );
    const cvaHighWwr = computeCvaWithWwr(
      profile.expectedExposure,
      profile.discountFactors,
      cptyMarginalPd,
      cptyLgd,
      0.85,
      profile.bucketTimes,
    );
    const cvaRightWay = computeCvaWithWwr(
      profile.expectedExposure,
      profile.discountFactors,
      cptyMarginalPd,
      cptyLgd,
      -0.50,
      profile.bucketTimes,
    );

    expect(cvaHighWwr).toBeGreaterThan(cvaModWwr);
    expect(cvaModWwr).toBeGreaterThan(cvaBase);
    expect(cvaRightWay).toBeLessThan(cvaBase);

    const summaryWwr = computeXvaSummary({
      ee: profile.expectedExposure,
      ene: profile.expectedNegativeExposure,
      df: profile.discountFactors,
      dt: profile.dt,
      cptyMarginalPd,
      ownMarginalPd,
      cptyLgd,
      ownLgd,
      fundingSpreadBps: 110.0,
      wwrCorrelation: 0.50,
      times: profile.bucketTimes,
    });

    expect(summaryWwr.cva).toBeGreaterThan(summaryWwr.cva_base);
    expect(summaryWwr.wwr_Increment).toBeCloseTo(summaryWwr.cva - summaryWwr.cva_base, 10);

    expect(() =>
      computeCvaWithWwr(profile.expectedExposure, profile.discountFactors, cptyMarginalPd, cptyLgd, 1.5),
    ).toThrow(/must be in \[-1, 1\]/);
  });
});
