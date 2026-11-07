/**
 * Fase 5 & Fase 6 — Motor XVA (CVA, DVA, FCA, FBA, MVA, KVA), Regla Anti-Doble-Conteo
 * y Wrong-Way Risk (WWR) Paramétrico.
 *
 * Referencias:
 * - Jon Gregory, "The xVA Challenge" (3rd ed., 2015):
 *   - Cap. 14 (CVA y DVA: formulación unilateral/bilateral y vista contable IFRS 13)
 *   - Cap. 15 (FVA: FCA y FBA; prohibición explícita de sumar DVA + FBA)
 *   - Cap. 16 (MVA sobre Initial Margin segregado y KVA sobre perfil de capital)
 *   - Cap. 17 (Wrong-Way Risk y Right-Way Risk)
 */

export interface XVASummary {
  cva: number;
  cva_base: number;
  wwr_Increment: number;
  dva: number;
  fca: number;
  fba: number;
  fva: number;
  mva: number;
  kva: number;
  /** Economic/Pricing view: -CVA - FCA + FBA (DVA strictly excluded, Gregory Cap. 15) */
  net_xva: number;
  /** Accounting/Balance-sheet IFRS 13 view: -CVA + DVA (Gregory Cap. 14) */
  accounting_xva: number;
  /** Economic view including MVA and KVA: -CVA - FCA + FBA - MVA - KVA (DVA excluded) */
  net_xva_all_in: number;
}

export interface FvaBreakdown {
  fca: number;
  fba: number;
  fva: number;
}

export interface XvaCalculationInput {
  ee: readonly number[];
  ene: readonly number[];
  df: readonly number[];
  dt: readonly number[];
  cptyMarginalPd: readonly number[];
  ownMarginalPd: readonly number[];
  cptyLgd: number;
  ownLgd: number;
  fundingSpreadBps: number;
  fbaSpreadBps?: number | null;
  ownSurvival?: readonly number[] | null;
  cptySurvival?: readonly number[] | null;
  /** Perfil de Initial Margin segregado IM(t_i) para MVA (opcional) */
  imProfile?: readonly number[] | null;
  /** Spread de remuneración del IM en bps (default 0 bps) */
  imRemunerationBps?: number;
  /** Perfil de Capital Económico/Regulatorio EC(t_i) para KVA (opcional) */
  capitalProfile?: readonly number[] | null;
  /** Costo de capital anualizado (ej. 0.10 = 10%) */
  costOfCapitalAnnual?: number;
  /** Correlación paramétrica WWR rho in [-1, 1] (Fase 6, Gregory Cap. 17) */
  wwrCorrelation?: number;
  /** Escala temporal t_i para modulación de WWR (opcional) */
  times?: readonly number[] | null;
}

function validateSameLength(nameA: string, a: readonly number[], nameB: string, b: readonly number[]): void {
  if (a.length === 0) {
    throw new Error(`${nameA} must be a non-empty array.`);
  }
  if (a.length !== b.length) {
    throw new Error(`Length mismatch: ${nameA} (${a.length}) vs ${nameB} (${b.length}).`);
  }
}

/**
 * Calcula CVA por cuadratura discreta sobre los buckets temporales:
 * CVA = LGD_C * sum_i EE(t_i) * DF(t_i) * dPD_C(t_{i-1}, t_i)
 * (Gregory Cap. 14 / `compute_cva` en `xva/cva_dva_fva.py`).
 */
export function computeCva(
  ee: readonly number[],
  df: readonly number[],
  marginalPd: readonly number[],
  lgd: number,
): number {
  validateSameLength('ee', ee, 'df', df);
  validateSameLength('ee', ee, 'marginalPd', marginalPd);
  if (lgd < 0 || lgd > 1) {
    throw new Error('lgd must be in [0, 1].');
  }

  let sum = 0;
  for (let i = 0; i < ee.length; i++) {
    sum += ee[i] * df[i] * marginalPd[i];
  }
  return lgd * sum;
}

/**
 * Calcula DVA usando nuestra exposición negativa esperada ENE(t) y nuestra propia dPD:
 * DVA = LGD_B * sum_i ENE(t_i) * DF(t_i) * dPD_B(t_{i-1}, t_i)
 * (Gregory Cap. 14 / `compute_dva` en `xva/cva_dva_fva.py`).
 */
export function computeDva(
  ene: readonly number[],
  df: readonly number[],
  ownMarginalPd: readonly number[],
  ownLgd: number,
): number {
  validateSameLength('ene', ene, 'df', df);
  validateSameLength('ene', ene, 'ownMarginalPd', ownMarginalPd);
  if (ownLgd < 0 || ownLgd > 1) {
    throw new Error('ownLgd must be in [0, 1].');
  }

  let sum = 0;
  for (let i = 0; i < ene.length; i++) {
    sum += ene[i] * df[i] * ownMarginalPd[i];
  }
  return ownLgd * sum;
}

/**
 * Calcula FCA, FBA y FVA = FCA - FBA sobre perfiles EE(t) y ENE(t)
 * (Gregory Cap. 15 / `compute_fva` en `xva/cva_dva_fva.py`).
 *
 * Nota crítica (Gregory Cap. 15): El FBA sólo surge de MTM negativo no colateralizado
 * o de Variation Margin rehipotecable; el Initial Margin segregado NUNCA genera FBA.
 */
export function computeFva(
  ee: readonly number[],
  ene: readonly number[],
  df: readonly number[],
  dt: readonly number[],
  fundingSpreadBps: number,
  ownSurvival?: readonly number[] | null,
  cptySurvival?: readonly number[] | null,
  fbaBps?: number | null,
): FvaBreakdown {
  validateSameLength('ee', ee, 'ene', ene);
  validateSameLength('ee', ee, 'df', df);
  validateSameLength('ee', ee, 'dt', dt);

  const fcaSpread = fundingSpreadBps / 10_000.0;
  const fbaSpread = (fbaBps ?? fundingSpreadBps) / 10_000.0;

  if (ownSurvival) validateSameLength('ee', ee, 'ownSurvival', ownSurvival);
  if (cptySurvival) validateSameLength('ee', ee, 'cptySurvival', cptySurvival);

  let fca = 0;
  let fba = 0;

  for (let i = 0; i < ee.length; i++) {
    const sOwn = ownSurvival ? ownSurvival[i] : 1.0;
    const sCpty = cptySurvival ? cptySurvival[i] : 1.0;
    const jointSurvival = sOwn * sCpty;
    const weight = df[i] * dt[i] * jointSurvival;
    fca += ee[i] * fcaSpread * weight;
    fba += ene[i] * fbaSpread * weight;
  }

  return {
    fca,
    fba,
    fva: fca - fba,
  };
}

/**
 * Calcula Margin Valuation Adjustment (MVA) sobre el perfil de Initial Margin segregado:
 * MVA = sum_i IM(t_i) * (s_funding - s_IM) * DF(t_i) * dt_i * S_joint(t_i)
 * (Gregory Cap. 16).
 */
export function computeMva(
  imProfile: readonly number[],
  df: readonly number[],
  dt: readonly number[],
  fundingSpreadBps: number,
  imRemunerationBps = 0,
  ownSurvival?: readonly number[] | null,
  cptySurvival?: readonly number[] | null,
): number {
  if (imProfile.length === 0) return 0;
  validateSameLength('imProfile', imProfile, 'df', df);
  validateSameLength('imProfile', imProfile, 'dt', dt);

  const netSpread = Math.max(0, fundingSpreadBps - imRemunerationBps) / 10_000.0;
  let mva = 0;
  for (let i = 0; i < imProfile.length; i++) {
    const sOwn = ownSurvival ? ownSurvival[i] : 1.0;
    const sCpty = cptySurvival ? cptySurvival[i] : 1.0;
    mva += Math.max(0, imProfile[i]) * netSpread * df[i] * dt[i] * sOwn * sCpty;
  }
  return mva;
}

/**
 * Construye un perfil simplificado de capital económico/regulatorio EC(t_i) a partir
 * de EE(t_i) y PFE(t_i) para el cálculo pedagógico de KVA (Gregory Cap. 16).
 *
 * // SUPUESTO (no en Gregory): Aproximación lineal SA-CCR / CEM simplificada
 * `EAD(t) = alpha * (0.4 * EE(t) + 0.6 * PFE(t))` con requerimiento de capital `8% * RW * EAD(t)`
 * para ilustrar KVA en el navegador sin requerir un motor RWA regulatorio completo.
 */
export function buildSimplifiedCapitalProfile(
  ee: readonly number[],
  pfe: readonly number[],
  riskWeight = 0.50,
  alpha = 1.4,
  capitalRatio = 0.08,
): number[] {
  validateSameLength('ee', ee, 'pfe', pfe);
  return ee.map((eeVal, idx) => {
    const ead = alpha * (0.4 * Math.max(0, eeVal) + 0.6 * Math.max(0, pfe[idx]));
    return ead * riskWeight * capitalRatio;
  });
}

/**
 * Calcula Capital Valuation Adjustment (KVA) sobre el perfil de capital requerido:
 * KVA = sum_i EC(t_i) * CoC * DF(t_i) * dt_i
 * (Gregory Cap. 16).
 */
export function computeKva(
  capitalProfile: readonly number[],
  df: readonly number[],
  dt: readonly number[],
  costOfCapitalAnnual = 0.10,
): number {
  if (capitalProfile.length === 0) return 0;
  validateSameLength('capitalProfile', capitalProfile, 'df', df);
  validateSameLength('capitalProfile', capitalProfile, 'dt', dt);
  if (costOfCapitalAnnual < 0) {
    throw new Error('costOfCapitalAnnual must be non-negative.');
  }

  let kva = 0;
  for (let i = 0; i < capitalProfile.length; i++) {
    kva += Math.max(0, capitalProfile[i]) * costOfCapitalAnnual * df[i] * dt[i];
  }
  return kva;
}

/**
 * Fase 6 — Wrong-Way Risk (WWR) paramétrico (Gregory Cap. 17, FR-5.1).
 *
 * Modela la dependencia entre la exposición y la intensidad de default de la contraparte
 * mediante el parámetro de correlación rho in [-1, 1]:
 *   EE_WWR(t_i) = EE(t_i) * exp(rho * sigma_WWR * sqrt(t_i))
 * donde:
 * - rho = 0 reproduce exactamente el CVA base sin WWR.
 * - rho > 0 (Wrong-Way Risk: p.ej. corporativo chileno pagando UF cuando la inflación/UF se dispara)
 *   incrementa la exposición condicional al default -> CVA_WWR > CVA_base.
 * - rho < 0 (Right-Way Risk) reduce la exposición condicional al default -> CVA_WWR < CVA_base.
 *
 * // SUPUESTO (no en Gregory): Parametrización exponencial cerrada con `sigmaWwr = 0.45`
 * para escalar de forma monótona la exposición condicional al default en función de `rho in [-1, 1]`.
 */
export function applyWwrToExposure(
  ee: readonly number[],
  rho: number,
  times?: readonly number[] | null,
  sigmaWwr = 0.45,
): number[] {
  if (rho < -1 || rho > 1 || Number.isNaN(rho)) {
    throw new Error(`wwrCorrelation rho must be in [-1, 1], got ${rho}.`);
  }
  if (rho === 0) {
    return [...ee];
  }
  return ee.map((val, idx) => {
    const t = times && times[idx] !== undefined ? Math.max(0, times[idx]) : (idx + 1) * 0.5;
    const multiplier = Math.exp(rho * sigmaWwr * Math.sqrt(Math.min(t, 10.0)));
    return val * multiplier;
  });
}

/**
 * Calcula CVA ajustado por Wrong-Way Risk paramétrico (Fase 6, Gregory Cap. 17).
 */
export function computeCvaWithWwr(
  ee: readonly number[],
  df: readonly number[],
  marginalPd: readonly number[],
  lgd: number,
  rho = 0,
  times?: readonly number[] | null,
): number {
  const eeWwr = applyWwrToExposure(ee, rho, times);
  return computeCva(eeWwr, df, marginalPd, lgd);
}

/**
 * Calcula el resumen completo de XVA respetando la regla dura anti-doble-conteo
 * (Gregory Cap. 14 y Cap. 15, AGENTS.md, FR-4.4 y FR-4.5):
 *
 * - Vista económica / pricing (`net_xva`):
 *     `net_xva = -cva - fca + fba`  (excluye DVA para no duplicar el beneficio de fondeo FBA)
 * - Vista contable / balance IFRS 13 (`accounting_xva`):
 *     `accounting_xva = -cva + dva`
 * - NUNCA se suman DVA y FBA en la misma métrica.
 */
export function computeXvaSummary(input: XvaCalculationInput): XVASummary {
  const rho = input.wwrCorrelation ?? 0;
  const cvaBase = computeCva(input.ee, input.df, input.cptyMarginalPd, input.cptyLgd);
  const cva =
    rho === 0
      ? cvaBase
      : computeCvaWithWwr(
          input.ee,
          input.df,
          input.cptyMarginalPd,
          input.cptyLgd,
          rho,
          input.times,
        );

  const dva = computeDva(input.ene, input.df, input.ownMarginalPd, input.ownLgd);
  const fvaBreakdown = computeFva(
    input.ee,
    input.ene,
    input.df,
    input.dt,
    input.fundingSpreadBps,
    input.ownSurvival,
    input.cptySurvival,
    input.fbaSpreadBps,
  );

  const mva = input.imProfile
    ? computeMva(
        input.imProfile,
        input.df,
        input.dt,
        input.fundingSpreadBps,
        input.imRemunerationBps ?? 0,
        input.ownSurvival,
        input.cptySurvival,
      )
    : 0;

  const kva = input.capitalProfile
    ? computeKva(
        input.capitalProfile,
        input.df,
        input.dt,
        input.costOfCapitalAnnual ?? 0.10,
      )
    : 0;

  // Regla Dura (Gregory Cap. 15 / demo.py):
  // Vista Económica (pricing): net_xva = -CVA - FCA + FBA (DVA excluido)
  const net_xva = -cva - fvaBreakdown.fca + fvaBreakdown.fba;
  // Vista Contable (IFRS 13): accounting_xva = -CVA + DVA
  const accounting_xva = -cva + dva;
  // Total Económico All-In (incluyendo MVA y KVA si aplica, siempre sin DVA)
  const net_xva_all_in = net_xva - mva - kva;

  const summary: XVASummary = {
    cva,
    cva_base: cvaBase,
    wwr_Increment: cva - cvaBase,
    dva,
    fca: fvaBreakdown.fca,
    fba: fvaBreakdown.fba,
    fva: fvaBreakdown.fva,
    mva,
    kva,
    net_xva,
    accounting_xva,
    net_xva_all_in,
  };

  assertNoDvaFbaDoubleCounting(summary);
  return summary;
}

/**
 * Verificador invariante que lanza error si `net_xva` incluye DVA junto con FBA
 * o si `accounting_xva` mezcla FVA con DVA (Gregory Cap. 15).
 */
export function assertNoDvaFbaDoubleCounting(summary: XVASummary): void {
  const expectedEconomic = -summary.cva - summary.fca + summary.fba;
  const expectedAccounting = -summary.cva + summary.dva;

  if (Math.abs(summary.net_xva - expectedEconomic) > 1e-9) {
    throw new Error(
      `Double-counting violation: net_xva (${summary.net_xva}) must equal -cva - fca + fba (${expectedEconomic}) with DVA strictly excluded (Gregory Cap. 15).`,
    );
  }
  if (Math.abs(summary.accounting_xva - expectedAccounting) > 1e-9) {
    throw new Error(
      `Accounting XVA violation: accounting_xva (${summary.accounting_xva}) must equal -cva + dva (${expectedAccounting}) (Gregory Cap. 14 / IFRS 13).`,
    );
  }
  if (summary.dva > 0 && summary.fba > 0) {
    const forbiddenSum = -summary.cva + summary.dva - summary.fca + summary.fba;
    if (Math.abs(summary.net_xva - forbiddenSum) < 1e-9) {
      throw new Error(
        'CRITICAL QUANT ERROR: DVA and FBA cannot be summed together in net_xva (Gregory Cap. 15 double counting).',
      );
    }
  }
}
