import { describe, expect, it } from 'vitest';
import {
  createCSA,
  createMonteCarloConfig,
  createTrade,
} from '../src/domain/builder';
import type { MarketEnv } from '../src/domain/types';
import { sampleMarketCurves } from '../src/engine/curves';
import {
  buildExpectedExposureProfile,
  collateralSpikeReport,
  computeExposureProfileFromPaths,
  expectedNegativeExposureFromEe,
  ndsPfe,
  physicalDeliveryPfe,
  simulateNettingSetExposure,
} from '../src/engine/exposure';

describe('Fase 4 — Exposure Engine: Netting, CSA (MPOR, Threshold, MTA, Segregated IM), EE/ENE/PFE & Settlement Spike (FR-3.2, FR-4, Gregory Cap. 6, 7, 11)', () => {
  const curves = sampleMarketCurves();
  const market: MarketEnv = {
    asOf: '2026-11-07',
    curves: curves.toRecord(),
    fxSpot: { UFCLP: 38_000, USDCLP: 950 },
    fxVol: { UFCLP: 0.10, USDCLP: 0.12 },
    rateVol: { SOFR: 0.0, CAMARA_CLP: 0.0, CAMARA_UF: 0.0 },
  };

  it('reproduces build_expected_exposure_profile, expected_negative_exposure_from_ee, and collateral_spike_report from exposure.py', () => {
    const times = [0.5, 1.0, 2.0, 3.0, 5.0];
    const ee = buildExpectedExposureProfile(times, 38_000, 500_000, 0.10);
    // At t = 5.0 (t == t_max): amortization = 1 - 0.35 = 0.65
    // 500_000 * 38_000 * 0.10 * sqrt(5) * 0.65 = 2,761,543,952.21224
    const expected5Y = 500_000 * 38_000 * 0.10 * Math.sqrt(5.0) * 0.65;
    expect(ee[4]).toBeCloseTo(expected5Y, 4);

    const ene = expectedNegativeExposureFromEe(ee, 0.55);
    expect(ene[4]).toBeCloseTo(expected5Y * 0.55, 4);

    // Physical vs NDS settlement spike report (Herstatt risk vs fixing differential)
    const notionalClp = 500_000 * 38_000;
    const report = collateralSpikeReport(notionalClp, 0.12);
    const refPhys = physicalDeliveryPfe(notionalClp, 0.12, 2);
    const refNds = ndsPfe(notionalClp, 0.12, 1);

    expect(report.physical_pfe_99).toBeCloseTo(refPhys, 6);
    expect(report.nds_pfe_99).toBeCloseTo(refNds, 6);
    expect(report.spike_ratio).toBeGreaterThan(50); // Physical delivery is >50x larger than NDS fixing PFE
    expect(report.excess_exposure_clp).toBeCloseTo(refPhys - refNds, 6);
  });

  it('reduces EE(t), PFE(t), EPE and EEPE when a bilateral CSA is applied, and keeps EE >= 0 & ENE >= 0 (FR-3.2, FR-4.2)', () => {
    const trade = createTrade({
      id: 'ccs_1',
      counterpartyId: 'cpty_1',
      product: 'CCS_UF_CLP',
      notionalUF: 500_000,
      ufClpFxFixed: 38_000,
      maturityYears: 5.0,
      direction: 'RECEIVE',
    });

    const mc = createMonteCarloConfig({ numPaths: 500, gridPointsPerYear: 4, seed: 42 });
    const csa = createCSA({
      id: 'csa_cpty_1',
      type: 'TWO_WAY',
      thresholdCpty: 5_000, // 5,000 UF threshold
      thresholdOwn: 5_000,
      mta: 500,
      mporDays: 10,
      initialMargin: 2_000,
      segregatedIM: true,
    });

    const { profile } = simulateNettingSetExposure([trade], market, curves, mc, csa, 0.99);

    for (let i = 0; i < profile.times.length; i++) {
      expect(profile.ee[i]).toBeGreaterThanOrEqual(0);
      expect(profile.ene[i]).toBeGreaterThanOrEqual(0);
      expect(profile.ee[i]).toBeLessThan(profile.eeUncollateralized[i]);
      expect(profile.pfe[i]).toBeLessThan(profile.pfeUncollateralized[i]);
      // Effective EE is non-decreasing
      if (i > 0) {
        expect(profile.eee[i]).toBeGreaterThanOrEqual(profile.eee[i - 1]);
      }
    }

    expect(profile.epe).toBeLessThan(profile.epeUncollateralized);
    expect(profile.eepe).toBeGreaterThan(0);

    // Deterministic seed check: second run with same seed gives identical EPE and EEPE
    const run2 = simulateNettingSetExposure([trade], market, curves, mc, csa, 0.99);
    expect(run2.profile.epe).toBe(profile.epe);
    expect(run2.profile.eepe).toBe(profile.eepe);
  });

  it('Demonstrates netting benefit: two offsetting trades in a Netting Set have lower EPE than standalone (FR-4.1, Gregory Cap. 6)', () => {
    const tRec = createTrade({
      id: 'ccs_rec',
      counterpartyId: 'cpty_1',
      product: 'CCS_UF_CLP',
      notionalUF: 500_000,
      ufClpFxFixed: 38_000,
      maturityYears: 5.0,
      direction: 'RECEIVE',
    });
    const tPay = createTrade({
      id: 'ccs_pay',
      counterpartyId: 'cpty_1',
      product: 'CCS_UF_CLP',
      notionalUF: 300_000,
      ufClpFxFixed: 38_000,
      maturityYears: 5.0,
      direction: 'PAY',
    });

    const mc = createMonteCarloConfig({ numPaths: 200, gridPointsPerYear: 2, seed: 99 });
    const standaloneRec = simulateNettingSetExposure([tRec], market, curves, mc, null);
    const standalonePay = simulateNettingSetExposure([tPay], market, curves, mc, null);
    const netted = simulateNettingSetExposure([tRec, tPay], market, curves, mc, null);

    expect(netted.profile.epe).toBeLessThan(standaloneRec.profile.epe + standalonePay.profile.epe);
    expect(netted.profile.epe).toBeCloseTo(standaloneRec.profile.epe - standalonePay.profile.epe, 4);
  });

  it('verifies segregated IM reduces positive exposure without increasing ENE (Gregory Cap. 11 & Cap. 15)', () => {
    const times = [0.5, 1.0];
    const paths = [
      [100, 150],
      [-100, -150],
    ];
    const csaNoIm = createCSA({
      id: 'c1_no_im',
      type: 'TWO_WAY',
      thresholdCpty: 50,
      thresholdOwn: 50,
      mta: 0,
      mporDays: 0,
      initialMargin: 0,
      segregatedIM: false,
    });
    const csaWithIm = createCSA({
      id: 'c1_with_im',
      type: 'TWO_WAY',
      thresholdCpty: 50,
      thresholdOwn: 50,
      mta: 0,
      mporDays: 0,
      initialMargin: 20,
      segregatedIM: true,
    });

    const pNoIm = computeExposureProfileFromPaths(times, paths, csaNoIm);
    const pWithIm = computeExposureProfileFromPaths(times, paths, csaWithIm);

    // Positive exposure is reduced by segregatedIM
    expect(pWithIm.ee[0]).toBeLessThan(pNoIm.ee[0]);
    // Negative exposure (ENE) is NOT affected by segregatedIM (cannot be rehypothecated)
    expect(pWithIm.ene[0]).toBe(pNoIm.ene[0]);
  });
});
