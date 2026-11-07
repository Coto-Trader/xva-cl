/**
 * Domain Model Entities — XVA.cl (Fase 0)
 *
 * Faithful to Jon Gregory, "The xVA Challenge: Counterparty Credit Risk,
 * Funding, Collateral and Capital" (3rd ed., Wiley, 2015).
 *
 * Pure domain types with zero UI or engine dependencies (docs/DATA-MODEL.md).
 */

export type Currency = 'USD' | 'CLP' | 'UF' | 'EUR';
export type CurveName = 'SOFR' | 'CAMARA_CLP' | 'CAMARA_UF';
export type Rating = 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'CCC' | 'NR';
export type CSAType = 'NO_CSA' | 'ONE_WAY' | 'TWO_WAY';
export type CSAScope = 'GLOBAL' | 'TRADE';
export type Direction = 'PAY' | 'RECEIVE';
export type ProductType = 'CCS_UF_CLP' | 'IRS' | 'FX_FORWARD';

/**
 * Continuous zero-rate curve definition (Gregory Cap. 13).
 * Discount factor: df(t) = exp(-z(t) * t), with df(0) = 1.
 */
export interface ZeroCurveData {
  name: CurveName;
  /** Strictly increasing maturities in years (> 0). */
  tenors: number[];
  /** Continuous zero rates in decimal (e.g. 0.05 = 5%). */
  zeroRates: number[];
}

/**
 * Direct CDS term structure for liquid counterparties (Gregory Cap. 12).
 */
export interface CreditCurveData {
  /** Maturities in years, strictly increasing (> 0). */
  tenors: number[];
  /** Par CDS spreads in decimal (e.g. 0.015 = 150 bps). */
  cdsSpreads: number[];
  /** Recovery rate in [0, 1); LGD = 1 - recoveryRate. */
  recoveryRate: number;
}

/**
 * Proxy mapping key for illiquid counterparties without liquid CDS quotes.
 * Gregory Cap. 12: "the bank must use a proxy spread that is appropriate
 * based on the rating, industry and region".
 */
export interface ProxyKey {
  rating: Rating;
  /** Sector / industry (e.g. 'Corporate', 'Sovereign', 'Bank'). */
  sector: string;
  /** Geographical region (e.g. 'Chile', 'LatAm', 'DM'). */
  region: string;
}

/**
 * Market environment snapshot (curves, spot FX, volatilities, funding spread).
 */
export interface MarketEnv {
  /** Valuation date in ISO format (YYYY-MM-DD). */
  asOf: string;
  /** Discount curves indexed by CurveName (Gregory Cap. 13: OIS discounting). */
  curves: Record<CurveName, ZeroCurveData>;
  /** Spot FX rates (e.g. { UFCLP: 38000 }). */
  fxSpot: Record<string, number>;
  /** Annualized FX volatilities in decimal (e.g. { UFCLP: 0.10 }). */
  fxVol: Record<string, number>;
  /** Optional annualized interest rate volatilities by curve. */
  rateVol?: Partial<Record<CurveName, number>>;
  /** Optional treasury funding spread in decimal (Gregory Cap. 15, e.g. 0.0050 = 50 bps). */
  fundingSpread?: number;
}

/**
 * Counterparty or Own-institution entity (Gregory Cap. 12, Cap. 14).
 * Rule (Gregory Cap. 12): Either a valid `creditCurve` or a valid `proxyKey`
 * MUST be present; a counterparty can never lack both.
 */
export interface Counterparty {
  id: string;
  name: string;
  rating: Rating;
  sector: string;
  region: string;
  /** Recovery rate in [0, 1). LGD = 1 - recoveryRate. */
  recoveryRate: number;
  /** Liquid CDS term structure when available. */
  creditCurve?: CreditCurveData;
  /** Mandatory proxy mapping when creditCurve is absent (Gregory Cap. 12). */
  proxyKey?: ProxyKey;
  /** True if this entity represents our own institution (for DVA / FBA). */
  ownParty?: boolean;
}

/**
 * Credit Support Annex (CSA) / Collateral agreement (Gregory Cap. 6, 11, 13, 15).
 * - IM acts like a negative threshold for CVA but if segregated cannot be
 *   used for funding benefit (Gregory Cap. 6 & Cap. 15).
 * - MPOR (Margin Period of Risk) lookback applies to collateralized exposure (Gregory Cap. 11).
 */
export interface CSA {
  id: string;
  scope: CSAScope;
  type: CSAType;
  /** Threshold applied to our own party (collateral we post above this negative MTM). */
  thresholdOwn: number;
  /** Threshold applied to the counterparty (collateral they post above this positive MTM). */
  thresholdCpty: number;
  /** Minimum Transfer Amount (Gregory Cap. 6: additive with threshold). */
  mta: number;
  /** Initial Margin amount (Gregory Cap. 6, Cap. 16). */
  initialMargin: number;
  /** Rounding lot size for collateral calls (> 0 or 0 for none). */
  rounding: number;
  /** Eligible collateral currencies (Gregory Cap. 13: cheapest-to-deliver). */
  eligibleCcy: Currency[];
  /** Valuation haircuts by collateral asset/currency key in [0, 1). */
  haircuts: Record<string, number>;
  /** Margin Period of Risk in business days (Gregory Cap. 8 & Cap. 11: typically 10–20 days). */
  mporDays: number;
  /** OIS curve governing collateral remuneration and discounting (Gregory Cap. 13). */
  collateralRate: CurveName;
  /** If true, IM is segregated and excluded from FVA funding benefit (Gregory Cap. 15). */
  segregatedIM: boolean;
}

/**
 * Base trade contract shared across OTC derivative products.
 */
export interface TradeBase {
  id: string;
  counterpartyId: string;
  product: ProductType;
  notional: number;
  currency: Currency;
  /** Trade start date (ISO YYYY-MM-DD). */
  startDate: string;
  /** Remaining maturity in years (> 0). */
  maturityYears: number;
  /** PAY or RECEIVE wrt the primary/fixed leg. */
  direction: Direction;
  /** Optional trade-level CSA override that supersedes the global CSA (FR-7.2). */
  csaOverrideId?: string;
}

/**
 * Cross-Currency Swap UF/CLP (CCS_UF_CLP) — primary product (docs/DATA-MODEL.md).
 */
export interface CCSUFCLPTrade extends TradeBase {
  product: 'CCS_UF_CLP';
  /** Notional in UF (> 0). */
  notionalUF: number;
  /** Fixed UF/CLP exchange rate at inception (> 0, e.g. 38000). */
  ufClpFxFixed: number;
  /** True = Non-Deliverable Swap (NDS, net cash settlement); False = physical principal exchange. */
  nonDeliverable: boolean;
  /** Optional fixed UF coupon rate in decimal (default 0.025 = 2.5%). // SUPUESTO (no en Gregory) */
  ufFixedRate?: number;
  /** Optional fixed/floating CLP spread or rate in decimal (default 0.055 = 5.5%). // SUPUESTO (no en Gregory) */
  clpLegRate?: number;
}

/**
 * Interest Rate Swap (IRS) extension.
 */
export interface IRSTrade extends TradeBase {
  product: 'IRS';
  fixedRate: number;
  floatCurve?: CurveName;
}

/**
 * FX Forward extension.
 */
export interface FXForwardTrade extends TradeBase {
  product: 'FX_FORWARD';
  strikeFx: number;
}

export type AnyTrade = CCSUFCLPTrade | IRSTrade | FXForwardTrade;

/**
 * Netting Set — fundamental unit of exposure and XVA aggregation.
 * Gregory Cap. 5 & Cap. 14: CVA/DVA/FVA must be computed at the netting-set level.
 */
export interface NettingSet {
  id: string;
  counterpartyId: string;
  /** Applicable CSA id (resolved from trade override or global relationship CSA). */
  csaId: string;
  tradeIds: string[];
}

/**
 * Complete portfolio of counterparties, CSAs, trades, and derived netting sets.
 */
export interface Portfolio {
  counterparties: Counterparty[];
  csas: CSA[];
  trades: AnyTrade[];
  nettingSets: NettingSet[];
}

/**
 * Monte Carlo simulation configuration (Gregory Cap. 10, NFR-2, NFR-3).
 */
export interface MonteCarloConfig {
  /** Number of simulation paths (v1 <= 10,000 per NFR-2). */
  numPaths: number;
  /** Time steps per year along the simulation grid. */
  gridPointsPerYear: number;
  /** Deterministic PRNG seed for exact reproducibility (NFR-3). */
  seed: number;
  /** Pathwise simulation mode required for collateral lookback / MPOR (Gregory Cap. 10). */
  pathwise: boolean;
}

/**
 * Persistable & exportable scenario unit (FR-7.3).
 */
export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  market: MarketEnv;
  portfolio: Portfolio;
  mc: MonteCarloConfig;
}

/**
 * Structured validation issue returned by `validatePortfolio` (docs/DATA-MODEL.md).
 */
export interface ValidationIssue {
  entityType: 'COUNTERPARTY' | 'CSA' | 'TRADE' | 'NETTING_SET' | 'PORTFOLIO';
  entityId: string;
  field: string;
  message: string;
  severity: 'ERROR' | 'WARNING';
}
