import { describe, expect, it } from 'vitest';
import {
  buildNettingSets,
  createCounterparty,
  createCSA,
  createMonteCarloConfig,
  createTrade,
  Portfolio,
  resolveEffectiveCSAId,
  validatePortfolio,
} from '../src/domain';

describe('Fase 0 — Domain Model & Builder (Gregory Cap. 5, 6, 11, 12, 13, 14, 15)', () => {
  describe('createCounterparty (FR-2.2 & FR-7.1)', () => {
    it('creates a valid counterparty with a direct CDS curve', () => {
      const cpty = createCounterparty({
        id: 'cpty_bank_a',
        name: 'Banco Austral',
        rating: 'A',
        sector: 'Bank',
        region: 'Chile',
        recoveryRate: 0.40,
        creditCurve: {
          tenors: [1, 3, 5],
          cdsSpreads: [0.008, 0.012, 0.015],
          recoveryRate: 0.40,
        },
      });

      expect(cpty.id).toBe('cpty_bank_a');
      expect(cpty.recoveryRate).toBe(0.40);
      expect(cpty.creditCurve?.cdsSpreads).toEqual([0.008, 0.012, 0.015]);
      expect(cpty.proxyKey).toBeUndefined();
    });

    it('creates a valid illiquid counterparty using a ProxyKey (Gregory Cap. 12)', () => {
      const cpty = createCounterparty({
        id: 'cpty_corp_b',
        name: 'Inmobiliaria Cordillera S.A.',
        rating: 'BBB',
        sector: 'Corporate',
        region: 'Chile',
        recoveryRate: 0.40,
        proxyKey: {
          rating: 'BBB',
          sector: 'Corporate',
          region: 'Chile',
        },
      });

      expect(cpty.id).toBe('cpty_corp_b');
      expect(cpty.creditCurve).toBeUndefined();
      expect(cpty.proxyKey).toEqual({
        rating: 'BBB',
        sector: 'Corporate',
        region: 'Chile',
      });
    });

    it('rejects a counterparty without both creditCurve and proxyKey (FR-2.2 acceptance)', () => {
      expect(() =>
        createCounterparty({
          id: 'cpty_invalid',
          name: 'Empresa Sin Credito',
          rating: 'BBB',
          sector: 'Corporate',
          region: 'Chile',
          recoveryRate: 0.40,
        })
      ).toThrow(/Gregory Cap\. 12/);
    });

    it('rejects invalid recoveryRate >= 1 or < 0 and non-increasing CDS tenors', () => {
      expect(() =>
        createCounterparty({
          id: 'cpty_bad_rec',
          name: 'Bad Recovery',
          rating: 'BBB',
          recoveryRate: 1.0,
          proxyKey: { rating: 'BBB', sector: 'Corporate', region: 'Chile' },
        })
      ).toThrow(/recoveryRate/);

      expect(() =>
        createCounterparty({
          id: 'cpty_bad_tenors',
          name: 'Non-monotonic Tenors',
          rating: 'BBB',
          recoveryRate: 0.4,
          creditCurve: {
            tenors: [1, 5, 3],
            cdsSpreads: [0.01, 0.015, 0.02],
            recoveryRate: 0.4,
          },
        })
      ).toThrow(/invalid creditCurve/);
    });
  });

  describe('createCSA (Gregory Cap. 6, 11, 13, 15)', () => {
    it('creates valid GLOBAL and TRADE CSAs with defaults', () => {
      const noCsa = createCSA({ id: 'csa_none', type: 'NO_CSA' });
      expect(noCsa.mporDays).toBe(0);
      expect(noCsa.thresholdCpty).toBe(Number.POSITIVE_INFINITY);

      const twoWay = createCSA({
        id: 'csa_bilateral',
        scope: 'GLOBAL',
        type: 'TWO_WAY',
        thresholdOwn: 25_000,
        thresholdCpty: 25_000,
        mta: 5_000,
        initialMargin: 10_000,
        rounding: 100,
        eligibleCcy: ['UF', 'CLP'],
        haircuts: { UF: 0.0, CLP: 0.02 },
        mporDays: 10,
        collateralRate: 'CAMARA_UF',
        segregatedIM: true,
      });

      expect(twoWay.type).toBe('TWO_WAY');
      expect(twoWay.mporDays).toBe(10);
      expect(twoWay.segregatedIM).toBe(true);
      expect(twoWay.collateralRate).toBe('CAMARA_UF');
    });

    it('rejects negative MTA, negative IM, negative MPOR, or invalid haircuts', () => {
      expect(() => createCSA({ id: 'c1', type: 'TWO_WAY', mta: -1 })).toThrow(/MTA/);
      expect(() => createCSA({ id: 'c2', type: 'TWO_WAY', initialMargin: -10 })).toThrow(/initialMargin/);
      expect(() => createCSA({ id: 'c3', type: 'TWO_WAY', mporDays: -5 })).toThrow(/mporDays/);
      expect(() => createCSA({ id: 'c4', type: 'TWO_WAY', haircuts: { CLP: 1.1 } })).toThrow(/haircut/);
    });
  });

  describe('createTrade & CCS_UF_CLP validation (FR-7.1, FR-7.2)', () => {
    it('creates a valid CCS_UF_CLP trade matching the reference specification', () => {
      const trade = createTrade({
        id: 'ccs_001',
        counterpartyId: 'cpty_corp_b',
        product: 'CCS_UF_CLP',
        notionalUF: 500_000,
        ufClpFxFixed: 38_000,
        maturityYears: 5,
        direction: 'RECEIVE',
        nonDeliverable: true,
      });

      expect(trade.product).toBe('CCS_UF_CLP');
      if (trade.product === 'CCS_UF_CLP') {
        expect(trade.notionalUF).toBe(500_000);
        expect(trade.ufClpFxFixed).toBe(38_000);
        expect(trade.nonDeliverable).toBe(true);
      }
    });

    it('rejects trades with non-positive notional or maturity', () => {
      expect(() =>
        createTrade({
          id: 'bad_ccs',
          counterpartyId: 'cpty_1',
          product: 'CCS_UF_CLP',
          notionalUF: 0,
          ufClpFxFixed: 38_000,
          maturityYears: 5,
        })
      ).toThrow(/notionalUF/);

      expect(() =>
        createTrade({
          id: 'bad_mat',
          counterpartyId: 'cpty_1',
          product: 'CCS_UF_CLP',
          notionalUF: 100_000,
          ufClpFxFixed: 38_000,
          maturityYears: -1,
        })
      ).toThrow(/maturityYears/);
    });
  });

  describe('buildNettingSets & CSA override resolution (FR-7.2, Gregory Cap. 5 & 14)', () => {
    it('groups trades under global CSA and separates trades with punctual csaOverrideId', () => {
      const cpty = createCounterparty({
        id: 'cpty_1',
        name: 'Cliente Corporativo 1',
        rating: 'A',
        sector: 'Corporate',
        region: 'Chile',
        recoveryRate: 0.4,
        proxyKey: { rating: 'A', sector: 'Corporate', region: 'Chile' },
      });

      const globalCsa = createCSA({
        id: 'csa_global',
        scope: 'GLOBAL',
        type: 'TWO_WAY',
        thresholdOwn: 50_000,
        thresholdCpty: 50_000,
        mporDays: 10,
      });

      const tradeCsa = createCSA({
        id: 'csa_trade_override',
        scope: 'TRADE',
        type: 'NO_CSA',
      });

      const t1 = createTrade({
        id: 't1',
        counterpartyId: 'cpty_1',
        product: 'CCS_UF_CLP',
        notionalUF: 300_000,
        ufClpFxFixed: 38_000,
        maturityYears: 5,
      });

      const t2 = createTrade({
        id: 't2',
        counterpartyId: 'cpty_1',
        product: 'CCS_UF_CLP',
        notionalUF: 200_000,
        ufClpFxFixed: 37_500,
        maturityYears: 3,
      });

      const t3Override = createTrade({
        id: 't3_punctual',
        counterpartyId: 'cpty_1',
        product: 'CCS_UF_CLP',
        notionalUF: 150_000,
        ufClpFxFixed: 38_200,
        maturityYears: 7,
        csaOverrideId: 'csa_trade_override',
      });

      expect(resolveEffectiveCSAId(t1, 'csa_global')).toBe('csa_global');
      expect(resolveEffectiveCSAId(t3Override, 'csa_global')).toBe('csa_trade_override');

      const portfolio: Portfolio = {
        counterparties: [cpty],
        csas: [globalCsa, tradeCsa],
        trades: [t1, t2, t3Override],
        nettingSets: [],
      };
      portfolio.nettingSets = buildNettingSets(portfolio);

      expect(portfolio.nettingSets).toHaveLength(2);
      const nsGlobal = portfolio.nettingSets.find((ns) => ns.csaId === 'csa_global');
      const nsPunctual = portfolio.nettingSets.find((ns) => ns.csaId === 'csa_trade_override');

      expect(nsGlobal?.tradeIds).toEqual(['t1', 't2']);
      expect(nsPunctual?.tradeIds).toEqual(['t3_punctual']);
      expect(validatePortfolio(portfolio)).toHaveLength(0);
    });

    it('validatePortfolio detects invalid counterparty without CDS/proxy and broken references', () => {
      const brokenPortfolio: Portfolio = {
        counterparties: [
          {
            id: 'cpty_no_credit',
            name: 'Sin CDS ni Proxy',
            rating: 'BBB',
            sector: 'Corporate',
            region: 'Chile',
            recoveryRate: 0.4,
          },
        ],
        csas: [],
        trades: [
          createTrade({
            id: 't_orphan',
            counterpartyId: 'cpty_missing',
            product: 'CCS_UF_CLP',
            notionalUF: 100_000,
            ufClpFxFixed: 38_000,
            maturityYears: 5,
            csaOverrideId: 'csa_missing',
          }),
        ],
        nettingSets: [],
      };

      const issues = validatePortfolio(brokenPortfolio);
      expect(issues.length).toBeGreaterThanOrEqual(3);
      expect(issues.some((i) => i.entityType === 'COUNTERPARTY' && i.entityId === 'cpty_no_credit')).toBe(true);
      expect(issues.some((i) => i.field === 'counterpartyId')).toBe(true);
      expect(issues.some((i) => i.field === 'csaOverrideId')).toBe(true);
    });

    it('validates MonteCarloConfig limits (NFR-2: numPaths <= 10,000)', () => {
      const mc = createMonteCarloConfig({ numPaths: 2000, gridPointsPerYear: 4, seed: 12345 });
      expect(mc.numPaths).toBe(2000);
      expect(() => createMonteCarloConfig({ numPaths: 25_000 })).toThrow(/NFR-2/);
    });
  });
});
