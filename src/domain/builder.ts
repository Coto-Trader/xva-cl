/**
 * Domain Builder & Validator — XVA.cl (Fase 0)
 *
 * Enforces all structural and quantitative invariants from Jon Gregory,
 * "The xVA Challenge" (3rd ed., 2015) and docs/DATA-MODEL.md / docs/REQUIREMENTS.md:
 * - Counterparty MUST have either a valid CDS curve or a valid ProxyKey (Gregory Cap. 12, FR-2.2).
 * - CSA thresholds, MTA, IM, rounding, MPOR, and eligible currencies validated (Gregory Cap. 6, 11, 13, 15).
 * - Trade-level CSA override (`csaOverrideId`) supersedes global CSA (FR-7.2).
 * - Netting sets aggregate trades by (counterpartyId, effectiveCsaId) (Gregory Cap. 5, Cap. 14).
 */

import {
  AnyTrade,
  CCSUFCLPTrade,
  Counterparty,
  CreditCurveData,
  CSA,
  Currency,
  FXForwardTrade,
  IRSTrade,
  MonteCarloConfig,
  NettingSet,
  Portfolio,
  ProxyKey,
  Rating,
  TradeBase,
  ValidationIssue,
} from './types';

const VALID_RATINGS: readonly Rating[] = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'NR'];

export function isValidCreditCurve(curve?: CreditCurveData): curve is CreditCurveData {
  if (!curve) return false;
  if (!Array.isArray(curve.tenors) || !Array.isArray(curve.cdsSpreads)) return false;
  if (curve.tenors.length === 0 || curve.tenors.length !== curve.cdsSpreads.length) return false;
  if (typeof curve.recoveryRate !== 'number' || curve.recoveryRate < 0 || curve.recoveryRate >= 1) {
    return false;
  }
  for (let i = 0; i < curve.tenors.length; i++) {
    const t = curve.tenors[i];
    const s = curve.cdsSpreads[i];
    if (!Number.isFinite(t) || t <= 0) return false;
    if (i > 0 && t <= curve.tenors[i - 1]) return false;
    if (!Number.isFinite(s) || s <= 0) return false;
  }
  return true;
}

export function isValidProxyKey(proxy?: ProxyKey): proxy is ProxyKey {
  if (!proxy) return false;
  if (!VALID_RATINGS.includes(proxy.rating)) return false;
  if (typeof proxy.sector !== 'string' || proxy.sector.trim().length === 0) return false;
  if (typeof proxy.region !== 'string' || proxy.region.trim().length === 0) return false;
  return true;
}

/**
 * Creates and validates a Counterparty entity.
 * Gregory Cap. 12 (FR-2.2): If no direct CDS curve is provided, `proxyKey`
 * (rating + sector + region) is mandatory. Never allow a counterparty without
 * both creditCurve and proxyKey.
 */
export function createCounterparty(partial: Partial<Counterparty> & { id?: string; name: string }): Counterparty {
  const id = (partial.id ?? `cpty_${Date.now()}`).trim();
  const name = (partial.name ?? '').trim();
  if (!id) {
    throw new Error('Counterparty id cannot be empty.');
  }
  if (!name) {
    throw new Error('Counterparty name cannot be empty.');
  }

  const rating: Rating = partial.rating ?? 'BBB';
  if (!VALID_RATINGS.includes(rating)) {
    throw new Error(`Invalid counterparty rating "${String(rating)}".`);
  }

  const recoveryRate = partial.recoveryRate ?? 0.40;
  if (!Number.isFinite(recoveryRate) || recoveryRate < 0 || recoveryRate >= 1) {
    throw new Error(`Invalid recoveryRate (${recoveryRate}): must be in [0, 1) so LGD = 1 - R > 0 (Gregory Cap. 12).`);
  }

  const sector = (partial.sector ?? '').trim();
  const region = (partial.region ?? '').trim();

  const hasCurve = partial.creditCurve !== undefined;
  if (hasCurve && !isValidCreditCurve(partial.creditCurve)) {
    throw new Error(
      `Counterparty "${name}" has an invalid creditCurve: tenors must be strictly increasing (>0), spreads >0, and recoveryRate in [0, 1).`
    );
  }

  const hasValidCurve = isValidCreditCurve(partial.creditCurve);
  const hasValidProxy = isValidProxyKey(partial.proxyKey);

  // Gregory Cap. 12: A counterparty without direct CDS must provide a valid proxyKey.
  if (!hasValidCurve && !hasValidProxy) {
    throw new Error(
      `Counterparty "${name}" is invalid (Gregory Cap. 12 / FR-2.2): must provide either a valid creditCurve (CDS) or a complete proxyKey (rating, sector, region).`
    );
  }

  return {
    id,
    name,
    rating,
    sector: sector || (partial.proxyKey?.sector ?? 'Corporate'),
    region: region || (partial.proxyKey?.region ?? 'Chile'),
    recoveryRate,
    creditCurve: hasValidCurve
      ? {
          tenors: [...partial.creditCurve!.tenors],
          cdsSpreads: [...partial.creditCurve!.cdsSpreads],
          recoveryRate: partial.creditCurve!.recoveryRate,
        }
      : undefined,
    proxyKey: hasValidProxy
      ? {
          rating: partial.proxyKey!.rating,
          sector: partial.proxyKey!.sector.trim(),
          region: partial.proxyKey!.region.trim(),
        }
      : undefined,
    ownParty: Boolean(partial.ownParty),
  };
}

/**
 * Creates and validates a CSA (Credit Support Annex) entity.
 * Enforces Gregory Cap. 6 (thresholds, MTA, IM, rounding), Cap. 11 (MPOR >= 0),
 * Cap. 13 (OIS collateral discounting curve & eligible currencies), Cap. 15 (segregated IM).
 */
export function createCSA(partial: Partial<CSA> & { id?: string }): CSA {
  const id = (partial.id ?? `csa_${Date.now()}`).trim();
  if (!id) {
    throw new Error('CSA id cannot be empty.');
  }

  const scope = partial.scope ?? 'GLOBAL';
  if (scope !== 'GLOBAL' && scope !== 'TRADE') {
    throw new Error(`Invalid CSA scope "${String(scope)}".`);
  }

  const type = partial.type ?? 'NO_CSA';
  if (type !== 'NO_CSA' && type !== 'ONE_WAY' && type !== 'TWO_WAY') {
    throw new Error(`Invalid CSA type "${String(type)}".`);
  }

  const thresholdOwn = partial.thresholdOwn ?? (type === 'NO_CSA' ? Number.POSITIVE_INFINITY : 0);
  const thresholdCpty = partial.thresholdCpty ?? (type === 'NO_CSA' ? Number.POSITIVE_INFINITY : 0);
  const mta = partial.mta ?? 0;
  const initialMargin = partial.initialMargin ?? 0;
  const rounding = partial.rounding ?? 0;
  // Gregory Cap. 8 & Cap. 11: Standard bilateral MPOR is typically 10 business days (0 if uncollateralized).
  const mporDays = partial.mporDays ?? (type === 'NO_CSA' ? 0 : 10);

  if (thresholdOwn < 0 || Number.isNaN(thresholdOwn)) {
    throw new Error(`Invalid thresholdOwn (${thresholdOwn}): must be >= 0.`);
  }
  if (thresholdCpty < 0 || Number.isNaN(thresholdCpty)) {
    throw new Error(`Invalid thresholdCpty (${thresholdCpty}): must be >= 0.`);
  }
  if (!Number.isFinite(mta) || mta < 0) {
    throw new Error(`Invalid MTA (${mta}): must be finite and >= 0 (Gregory Cap. 6).`);
  }
  if (!Number.isFinite(initialMargin) || initialMargin < 0) {
    throw new Error(`Invalid initialMargin (${initialMargin}): must be finite and >= 0 (Gregory Cap. 6).`);
  }
  if (!Number.isFinite(rounding) || rounding < 0) {
    throw new Error(`Invalid rounding (${rounding}): must be finite and >= 0.`);
  }
  if (!Number.isFinite(mporDays) || mporDays < 0) {
    throw new Error(`Invalid mporDays (${mporDays}): must be finite and >= 0 (Gregory Cap. 11).`);
  }

  const eligibleCcy: Currency[] =
    partial.eligibleCcy && partial.eligibleCcy.length > 0 ? [...partial.eligibleCcy] : ['CLP'];
  const haircuts = partial.haircuts ? { ...partial.haircuts } : {};
  for (const [k, h] of Object.entries(haircuts)) {
    if (!Number.isFinite(h) || h < 0 || h >= 1) {
      throw new Error(`Invalid haircut for "${k}" (${h}): must be in [0, 1).`);
    }
  }

  const collateralRate = partial.collateralRate ?? 'CAMARA_CLP';
  if (collateralRate !== 'SOFR' && collateralRate !== 'CAMARA_CLP' && collateralRate !== 'CAMARA_UF') {
    throw new Error(`Invalid collateralRate "${String(collateralRate)}".`);
  }

  return {
    id,
    scope,
    type,
    thresholdOwn,
    thresholdCpty,
    mta,
    initialMargin,
    rounding,
    eligibleCcy,
    haircuts,
    mporDays,
    collateralRate,
    segregatedIM: partial.segregatedIM ?? true,
  };
}

/**
 * Creates and validates a Trade (CCS_UF_CLP, IRS, FX_FORWARD).
 */
export function createTrade(
  partial: Partial<CCSUFCLPTrade> & { id?: string; counterpartyId: string; product?: AnyTrade['product'] }
): AnyTrade {
  const id = (partial.id ?? `trd_${Date.now()}`).trim();
  const counterpartyId = (partial.counterpartyId ?? '').trim();
  if (!id) {
    throw new Error('Trade id cannot be empty.');
  }
  if (!counterpartyId) {
    throw new Error(`Trade "${id}" must reference a valid counterpartyId.`);
  }

  const product = partial.product ?? 'CCS_UF_CLP';
  const maturityYears = partial.maturityYears ?? 5;
  if (!Number.isFinite(maturityYears) || maturityYears <= 0) {
    throw new Error(`Trade "${id}" has invalid maturityYears (${maturityYears}): must be > 0.`);
  }

  const direction = partial.direction ?? 'RECEIVE';
  if (direction !== 'PAY' && direction !== 'RECEIVE') {
    throw new Error(`Trade "${id}" has invalid direction "${String(direction)}".`);
  }

  const startDate = (partial.startDate ?? '2026-11-07').trim();
  const csaOverrideId = partial.csaOverrideId?.trim() || undefined;

  if (product === 'CCS_UF_CLP') {
    const notionalUF = partial.notionalUF ?? partial.notional ?? 0;
    const ufClpFxFixed = partial.ufClpFxFixed ?? 38_000;
    if (!Number.isFinite(notionalUF) || notionalUF <= 0) {
      throw new Error(`CCS_UF_CLP trade "${id}" requires notionalUF > 0.`);
    }
    if (!Number.isFinite(ufClpFxFixed) || ufClpFxFixed <= 0) {
      throw new Error(`CCS_UF_CLP trade "${id}" requires ufClpFxFixed > 0.`);
    }
    const ccs: CCSUFCLPTrade = {
      id,
      counterpartyId,
      product: 'CCS_UF_CLP',
      notional: partial.notional ?? notionalUF,
      notionalUF,
      ufClpFxFixed,
      nonDeliverable: partial.nonDeliverable ?? true,
      currency: partial.currency ?? 'UF',
      startDate,
      maturityYears,
      direction,
      csaOverrideId,
      ufFixedRate: partial.ufFixedRate,
      clpLegRate: partial.clpLegRate,
    };
    return ccs;
  }

  const notional = partial.notional ?? 0;
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error(`Trade "${id}" requires notional > 0.`);
  }

  if (product === 'IRS') {
    const irs: IRSTrade = {
      id,
      counterpartyId,
      product: 'IRS',
      notional,
      currency: partial.currency ?? 'CLP',
      startDate,
      maturityYears,
      direction,
      csaOverrideId,
      fixedRate: (partial as Partial<IRSTrade>).fixedRate ?? 0.05,
      floatCurve: (partial as Partial<IRSTrade>).floatCurve ?? 'CAMARA_CLP',
    };
    return irs;
  }

  const fxf: FXForwardTrade = {
    id,
    counterpartyId,
    product: 'FX_FORWARD',
    notional,
    currency: partial.currency ?? 'CLP',
    startDate,
    maturityYears,
    direction,
    csaOverrideId,
    strikeFx: (partial as Partial<FXForwardTrade>).strikeFx ?? 38_000,
  };
  return fxf;
}

/**
 * Resolves the effective CSA ID for a trade per docs/DATA-MODEL.md & FR-7.2:
 * `trade.csaOverrideId ?? globalCsaId`.
 */
export function resolveEffectiveCSAId(trade: TradeBase, fallbackCsaId: string): string {
  return trade.csaOverrideId && trade.csaOverrideId.trim().length > 0
    ? trade.csaOverrideId.trim()
    : fallbackCsaId;
}

/**
 * Builds NettingSet entities by grouping trades by (counterpartyId, effectiveCsaId).
 * Gregory Cap. 5 & Cap. 14: The netting set is the unit of aggregation covered by a
 * specific legal netting and collateral agreement. If a trade specifies a `csaOverrideId`
 * (puntual CSA), it forms its own netting set under that CSA override; otherwise it joins
 * the counterparty's global CSA netting set.
 */
export function buildNettingSets(portfolio: Pick<Portfolio, 'counterparties' | 'csas' | 'trades' | 'nettingSets'>): NettingSet[] {
  const globalCsas = portfolio.csas.filter((c) => c.scope === 'GLOBAL');
  const defaultGlobalCsaId = globalCsas[0]?.id ?? portfolio.csas[0]?.id ?? 'NO_CSA';

  // Map existing counterparty -> global CSA if already specified in portfolio.nettingSets
  const cptyGlobalCsaMap = new Map<string, string>();
  for (const ns of portfolio.nettingSets ?? []) {
    const csaObj = portfolio.csas.find((c) => c.id === ns.csaId);
    if (!csaObj || csaObj.scope === 'GLOBAL') {
      if (!cptyGlobalCsaMap.has(ns.counterpartyId)) {
        cptyGlobalCsaMap.set(ns.counterpartyId, ns.csaId);
      }
    }
  }

  const grouped = new Map<string, NettingSet>();

  for (const trade of portfolio.trades) {
    const baseCsaId = cptyGlobalCsaMap.get(trade.counterpartyId) ?? defaultGlobalCsaId;
    const effectiveCsaId = resolveEffectiveCSAId(trade, baseCsaId);
    const key = `${trade.counterpartyId}::${effectiveCsaId}`;

    let ns = grouped.get(key);
    if (!ns) {
      ns = {
        id: `ns_${trade.counterpartyId}_${effectiveCsaId}`,
        counterpartyId: trade.counterpartyId,
        csaId: effectiveCsaId,
        tradeIds: [],
      };
      grouped.set(key, ns);
    }
    ns.tradeIds.push(trade.id);
  }

  return Array.from(grouped.values());
}

/**
 * Validates an entire Portfolio and returns all structural or domain issues (FR-7.1, FR-7.2).
 */
export function validatePortfolio(portfolio: Portfolio): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cptyIds = new Set<string>();
  const csaIds = new Set<string>();
  const tradeIds = new Set<string>();

  for (const cpty of portfolio.counterparties) {
    if (cptyIds.has(cpty.id)) {
      issues.push({
        entityType: 'COUNTERPARTY',
        entityId: cpty.id,
        field: 'id',
        message: `Duplicate counterparty id "${cpty.id}".`,
        severity: 'ERROR',
      });
    }
    cptyIds.add(cpty.id);

    try {
      createCounterparty(cpty);
    } catch (err) {
      issues.push({
        entityType: 'COUNTERPARTY',
        entityId: cpty.id || 'UNKNOWN',
        field: 'creditCurve/proxyKey',
        message: err instanceof Error ? err.message : String(err),
        severity: 'ERROR',
      });
    }
  }

  for (const csa of portfolio.csas) {
    if (csaIds.has(csa.id)) {
      issues.push({
        entityType: 'CSA',
        entityId: csa.id,
        field: 'id',
        message: `Duplicate CSA id "${csa.id}".`,
        severity: 'ERROR',
      });
    }
    csaIds.add(csa.id);

    try {
      createCSA(csa);
    } catch (err) {
      issues.push({
        entityType: 'CSA',
        entityId: csa.id || 'UNKNOWN',
        field: 'csa',
        message: err instanceof Error ? err.message : String(err),
        severity: 'ERROR',
      });
    }
  }

  for (const trade of portfolio.trades) {
    if (tradeIds.has(trade.id)) {
      issues.push({
        entityType: 'TRADE',
        entityId: trade.id,
        field: 'id',
        message: `Duplicate trade id "${trade.id}".`,
        severity: 'ERROR',
      });
    }
    tradeIds.add(trade.id);

    try {
      createTrade(trade as Partial<CCSUFCLPTrade> & { counterpartyId: string });
    } catch (err) {
      issues.push({
        entityType: 'TRADE',
        entityId: trade.id || 'UNKNOWN',
        field: 'trade',
        message: err instanceof Error ? err.message : String(err),
        severity: 'ERROR',
      });
    }

    if (!cptyIds.has(trade.counterpartyId)) {
      issues.push({
        entityType: 'TRADE',
        entityId: trade.id,
        field: 'counterpartyId',
        message: `Trade "${trade.id}" references non-existent counterpartyId "${trade.counterpartyId}".`,
        severity: 'ERROR',
      });
    }

    if (trade.csaOverrideId && !csaIds.has(trade.csaOverrideId)) {
      issues.push({
        entityType: 'TRADE',
        entityId: trade.id,
        field: 'csaOverrideId',
        message: `Trade "${trade.id}" references non-existent csaOverrideId "${trade.csaOverrideId}".`,
        severity: 'ERROR',
      });
    }
  }

  for (const ns of portfolio.nettingSets) {
    if (!cptyIds.has(ns.counterpartyId)) {
      issues.push({
        entityType: 'NETTING_SET',
        entityId: ns.id,
        field: 'counterpartyId',
        message: `NettingSet "${ns.id}" references unknown counterpartyId "${ns.counterpartyId}".`,
        severity: 'ERROR',
      });
    }
    if (ns.csaId !== 'NO_CSA' && !csaIds.has(ns.csaId)) {
      issues.push({
        entityType: 'NETTING_SET',
        entityId: ns.id,
        field: 'csaId',
        message: `NettingSet "${ns.id}" references unknown csaId "${ns.csaId}".`,
        severity: 'ERROR',
      });
    }
    for (const tid of ns.tradeIds) {
      if (!tradeIds.has(tid)) {
        issues.push({
          entityType: 'NETTING_SET',
          entityId: ns.id,
          field: 'tradeIds',
          message: `NettingSet "${ns.id}" references unknown tradeId "${tid}".`,
          severity: 'ERROR',
        });
      }
    }
  }

  return issues;
}

/**
 * Validates MonteCarloConfig (Gregory Cap. 10, NFR-2: v1 <= 10,000 paths).
 */
export function createMonteCarloConfig(partial?: Partial<MonteCarloConfig>): MonteCarloConfig {
  const numPaths = partial?.numPaths ?? 1000;
  const gridPointsPerYear = partial?.gridPointsPerYear ?? 4;
  const seed = partial?.seed ?? 42;
  const pathwise = partial?.pathwise ?? true;

  if (!Number.isInteger(numPaths) || numPaths < 10 || numPaths > 10_000) {
    throw new Error(`Invalid numPaths (${numPaths}): must be an integer between 10 and 10,000 (NFR-2).`);
  }
  if (!Number.isInteger(gridPointsPerYear) || gridPointsPerYear < 1 || gridPointsPerYear > 100) {
    throw new Error(`Invalid gridPointsPerYear (${gridPointsPerYear}): must be between 1 and 100.`);
  }
  if (!Number.isFinite(seed)) {
    throw new Error('MonteCarloConfig seed must be a finite number.');
  }

  return {
    numPaths,
    gridPointsPerYear,
    seed,
    pathwise,
  };
}
