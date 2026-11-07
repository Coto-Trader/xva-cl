/**
 * Fase 9 — Interfaz Interactiva en 5 Pasos de XVA.cl (docs/UI-UX.md, docs/REQUIREMENTS.md).
 *
 * Pasos del Wizard:
 * 1. Curvas (SOFR, CAMARA_CLP, CAMARA_UF con interpolación PCHIP, shifts paralelos y parámetros FX/Funding).
 * 2. Cliente y Banco Propio (CDS directo vs Proxy obligatorio por Rating/Sector/Región, Hazard Rate e IFRS 13).
 * 3. Colateral / CSA (Threshold, MTA, MPOR, Segregated IM, Cheapest-to-Deliver y Settlement Spike Physical vs NDS).
 * 4. Productos y Portafolio (CCS_UF_CLP, IRS, FX_FORWARD y Selector Global CSA vs Override Puntual por Trade).
 * 5. Resultados (Dos totales separados `net_xva` vs `accounting_xva`, Perfiles EE/ENE/PFE con y sin CSA,
 *    Waterfall XVA, Slider Wrong-Way Risk, QuickSens 3D, Semáforo DV01 y Recomendador de Coberturas con modal Gregory).
 */

import React, { useState } from 'react';
import { AuthGate } from '../auth/AuthGate';
import { createTrade } from '../domain/builder';
import type { CurveName, Direction, ProductType, Rating } from '../domain/types';
import { resolveCounterpartyHazardCurve } from '../engine/credit';
import { CurveSet } from '../engine/curves';
import type { HedgeRecommendation } from '../engine/hedging';
import { interpolateQuickSens } from '../engine/sensitivities';
import { type WizardStep, useXvaStore } from '../store/useXvaStore';

const WIZARD_STEPS: { step: WizardStep; title: string; desc: string }[] = [
  { step: 1, title: '1. Curvas', desc: 'SOFR · CAMARA · UF PCHIP' },
  { step: 2, title: '2. Cliente', desc: 'CDS / Proxy & Hazard' },
  { step: 3, title: '3. Colateral / CSA', desc: 'Threshold · MPOR · IM' },
  { step: 4, title: '4. Productos', desc: 'CCS UF/CLP & Overrides' },
  { step: 5, title: '5. Resultados', desc: 'XVA · WWR · Cobertura' },
];

function fmtUF(val: number, decimals = 1): string {
  return `${val.toLocaleString('es-CL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} UF`;
}

function fmtCLP(valUF: number, spotUfClp: number): string {
  const mmClp = (valUF * spotUfClp) / 1_000_000;
  return `${mmClp.toLocaleString('es-CL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} MM CLP`;
}

export const App: React.FC = () => {
  const store = useXvaStore();
  const { scenario, output, wizardStep } = store;

  const [selectedHedgeModal, setSelectedHedgeModal] = useState<HedgeRecommendation | null>(null);
  const [scenarioNameInput, setScenarioNameInput] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  // Estado local para agregar nueva operación en Paso 4
  const [newProduct, setNewProduct] = useState<ProductType>('CCS_UF_CLP');
  const [newNotionalUF, setNewNotionalUF] = useState<number>(250_000);
  const [newMaturity, setNewMaturity] = useState<number>(5.0);
  const [newDirection, setNewDirection] = useState<Direction>('RECEIVE');
  const [newCsaOverride, setNewCsaOverride] = useState<string>('');

  const curves = CurveSet.fromRecord(scenario.market.curves);
  const primaryCpty =
    scenario.portfolio.counterparties.find((c) => !c.ownParty) ??
    scenario.portfolio.counterparties[0];
  const ownBank =
    scenario.portfolio.counterparties.find((c) => c.ownParty) ??
    scenario.portfolio.counterparties[1];
  const globalCsa =
    scenario.portfolio.csas.find((c) => c.scope === 'GLOBAL') ?? scenario.portfolio.csas[0];

  const handleExportJson = () => {
    const json = store.exportScenarioJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scenario.id || 'xva_scenario'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJsonFile = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '');
        store.importScenarioJson(text);
        setImportError(null);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Error al importar JSON');
      }
    };
    reader.readAsText(file);
  };

  return (
    <AuthGate>
      {({ user, onSignOut }) => (
        <div>
          {/* Ecosystem Ribbon */}
          <div className="ecosystem-ribbon">
            <div className="ecosystem-links">
              <a href="https://segundaopinion.cl" target="_blank" rel="noreferrer">
                segundaopinion.cl
              </a>
              <span>·</span>
              <a href="https://xva.cl" className="active-site">
                xva.cl
              </a>
              <span>·</span>
              <a href="https://tradeai.cl" target="_blank" rel="noreferrer">
                Suite Trade AI ↗
              </a>
            </div>
            <div className="ecosystem-links">
              <span>Jon Gregory · The xVA Challenge (3rd ed.)</span>
              <span>|</span>
              <span>
                Sesión: <strong style={{ color: 'var(--text)' }}>{user.name}</strong>
              </span>
              <button type="button" className="btn btn-sm" onClick={onSignOut}>
                Salir
              </button>
            </div>
          </div>

          {/* Main Header */}
          <header className="app-header">
            <div className="brand-block">
              <div className="brand-badge">xVA</div>
              <div>
                <div className="brand-title">
                  XVA.cl — Valorización y Cobertura de Riesgo de Contraparte, Funding y Capital
                </div>
                <div className="brand-sub">
                  Motor Cuantitativo 100% Cliente · CVA · DVA · FCA · FBA · MVA · KVA · WWR · Greeks
                </div>
              </div>
            </div>

            <div className="header-controls">
              <input
                type="text"
                className="input-control"
                style={{ width: 190 }}
                placeholder="Nombre escenario..."
                value={scenarioNameInput}
                onChange={(e) => setScenarioNameInput(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  store.saveCurrentScenario(scenarioNameInput || undefined);
                  setScenarioNameInput('');
                }}
              >
                Guardar Local
              </button>
              <button type="button" className="btn btn-sm" onClick={handleExportJson}>
                Exportar .JSON
              </button>
              <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                Importar .JSON
                <input
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleImportJsonFile}
                />
              </label>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => store.resetToDefaultScenario()}
              >
                Reset Caso Base
              </button>
              <button
                type="button"
                className="btn-signal-primary"
                onClick={() => store.recomputeAsync()}
              >
                {store.isComputing
                  ? `Calculando (${store.progressPercent}%)...`
                  : 'Recalcular XVA'}
              </button>
            </div>
          </header>

          {importError && (
            <div
              style={{
                background: 'rgba(242,87,76,0.15)',
                borderBottom: '1px solid var(--down)',
                padding: '8px 20px',
                color: 'var(--down)',
              }}
            >
              {importError}
            </div>
          )}

          {/* 5-Step Wizard Navigation */}
          <nav className="wizard-bar" aria-label="Pasos del flujo XVA">
            {WIZARD_STEPS.map((s) => (
              <button
                key={s.step}
                type="button"
                className={`wizard-step-btn ${wizardStep === s.step ? 'active' : ''}`}
                onClick={() => store.setWizardStep(s.step)}
              >
                <span className="step-index">{s.step}</span>
                <span>
                  <span className="step-label-title">{s.title}</span>
                  <span className="step-label-desc">{s.desc}</span>
                </span>
              </button>
            ))}
          </nav>

          {/* Main Content Area */}
          <main className="main-container">
            {/* ==================== PASO 1: CURVAS ==================== */}
            {wizardStep === 1 && (
              <>
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h2 className="panel-title">
                        Paso 1 — Curvas de Descuento OIS y Parámetros de Mercado
                      </h2>
                      <p className="panel-subtitle">
                        Interpolación monótona PCHIP sobre tasas cero continuas (SOFR, CAMARA_CLP,
                        CAMARA_UF) con factor de descuento df(t) = exp(-z(t)·t) y df(0) = 1.
                      </p>
                    </div>
                    <span className="book-badge">Gregory Cap. 13 — OIS Discounting</span>
                  </div>

                  <div className="form-grid">
                    <div className="field-group">
                      <label className="field-label">Spot UF / CLP</label>
                      <input
                        type="number"
                        className="input-control"
                        value={scenario.market.fxSpot.UFCLP ?? 38000}
                        step={100}
                        onChange={(e) =>
                          store.updateMarketParams({ ufClpSpot: Number(e.target.value) || 38000 })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Volatilidad Anual UF/CLP (decimal)</label>
                      <input
                        type="number"
                        className="input-control"
                        value={scenario.market.fxVol.UFCLP ?? 0.1}
                        step={0.01}
                        min={0.01}
                        max={0.8}
                        onChange={(e) =>
                          store.updateMarketParams({ ufClpVol: Number(e.target.value) || 0.1 })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Spread de Fondeo Tesorería (bps)</label>
                      <input
                        type="number"
                        className="input-control"
                        value={Math.round((scenario.market.fundingSpread ?? 0.011) * 10000)}
                        step={5}
                        onChange={(e) =>
                          store.updateMarketParams({
                            fundingSpreadBps: Number(e.target.value) || 110,
                          })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Costo de Capital Anual KVA (%)</label>
                      <input
                        type="number"
                        className="input-control"
                        value={+(store.costOfCapitalAnnual * 100).toFixed(1)}
                        step={0.5}
                        onChange={(e) =>
                          store.setCostOfCapitalAnnual((Number(e.target.value) || 10) / 100)
                        }
                      />
                    </div>
                  </div>
                </div>

                <div className="grid-2">
                  {/* Gráfico SVG de Curvas Cero PCHIP */}
                  <div className="panel">
                    <div className="panel-header">
                      <div>
                        <h3 className="panel-title">Estructura Temporal de Tasas Cero PCHIP (%)</h3>
                        <p className="panel-subtitle">
                          Evaluación continua entre 0.25Y y 30Y sin oscilaciones espurias (Fritsch-Carlson).
                        </p>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {(['CAMARA_UF', 'CAMARA_CLP', 'SOFR'] as CurveName[]).map((cName) => (
                          <button
                            key={cName}
                            type="button"
                            className="btn btn-sm"
                            onClick={() => store.shiftCurveParallel(cName, 10)}
                            title={` Aplicar +10 bps paralelos a ${cName}`}
                          >
                            {cName} +10bp
                          </button>
                        ))}
                      </div>
                    </div>

                    <ZeroCurvesSvgChart curves={curves} />

                    <div className="gregory-callout">
                      <strong>Cheapest-to-Deliver (Gregory Cap. 13):</strong> Cuando un CSA permite
                      múltiples monedas elegibles, la parte que entrega colateral optimiza
                      entregando la moneda de mayor rendimiento implícito:{' '}
                      <code>
                        {curves.selectCheapestToDeliverCurve(globalCsa.eligibleCcy)}
                      </code>
                      .
                    </div>
                  </div>

                  {/* Tabla editable de Nodos por Curva */}
                  <div className="panel">
                    <div className="panel-header">
                      <div>
                        <h3 className="panel-title">Nodos de Curvas y Factores de Descuento</h3>
                        <p className="panel-subtitle">
                          Edita cualquier tasa cero (en %) para recalcular la interpolación PCHIP.
                        </p>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table className="quant-table">
                        <thead>
                          <tr>
                            <th>Tenor (Y)</th>
                            <th>SOFR (%)</th>
                            <th>CAMARA CLP (%)</th>
                            <th>CAMARA UF (%)</th>
                            <th>DF UF(t)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scenario.market.curves.CAMARA_UF.tenors.map((t, idx) => (
                            <tr key={t}>
                              <td className="num">{t.toFixed(2)}Y</td>
                              <td>
                                <input
                                  type="number"
                                  className="input-control"
                                  style={{ width: 88, padding: '4px 6px' }}
                                  step={0.05}
                                  value={+(
                                    scenario.market.curves.SOFR.zeroRates[idx] * 100
                                  ).toFixed(3)}
                                  onChange={(e) =>
                                    store.updateZeroCurveNode(
                                      'SOFR',
                                      idx,
                                      (Number(e.target.value) || 0) / 100,
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  className="input-control"
                                  style={{ width: 88, padding: '4px 6px' }}
                                  step={0.05}
                                  value={+(
                                    scenario.market.curves.CAMARA_CLP.zeroRates[idx] * 100
                                  ).toFixed(3)}
                                  onChange={(e) =>
                                    store.updateZeroCurveNode(
                                      'CAMARA_CLP',
                                      idx,
                                      (Number(e.target.value) || 0) / 100,
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  className="input-control"
                                  style={{ width: 88, padding: '4px 6px' }}
                                  step={0.05}
                                  value={+(
                                    scenario.market.curves.CAMARA_UF.zeroRates[idx] * 100
                                  ).toFixed(3)}
                                  onChange={(e) =>
                                    store.updateZeroCurveNode(
                                      'CAMARA_UF',
                                      idx,
                                      (Number(e.target.value) || 0) / 100,
                                    )
                                  }
                                />
                              </td>
                              <td className="num val-signal">
                                {curves.camara_uf.discountFactor(t).toFixed(6)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ==================== PASO 2: CLIENTE & CRÉDITO ==================== */}
            {wizardStep === 2 && (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h2 className="panel-title">
                        Paso 2 — Contraparte: Curva CDS vs Proxy Obligatorio
                      </h2>
                      <p className="panel-subtitle">
                        En el mercado chileno la mayoría de corporativos carece de CDS líquido: el
                        mapeo Proxy por Rating + Sector + Región es obligatorio cuando no hay CDS.
                      </p>
                    </div>
                    <span className="book-badge">Gregory Cap. 12 — Credit &amp; IFRS 13</span>
                  </div>

                  <div className="form-grid">
                    <div className="field-group">
                      <label className="field-label">Nombre Contraparte</label>
                      <input
                        type="text"
                        className="input-control"
                        value={primaryCpty.name}
                        onChange={(e) =>
                          store.updateCounterparty(primaryCpty.id, { name: e.target.value })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Rating Externo / Interno</label>
                      <select
                        className="select-control"
                        value={primaryCpty.rating}
                        onChange={(e) => {
                          const r = e.target.value as Rating;
                          store.updateCounterparty(primaryCpty.id, {
                            rating: r,
                            proxyKey: {
                              rating: r,
                              sector: primaryCpty.sector,
                              region: primaryCpty.region,
                            },
                          });
                        }}
                      >
                        {(['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'NR'] as Rating[]).map(
                          (r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Sector Industrial (Proxy)</label>
                      <select
                        className="select-control"
                        value={primaryCpty.sector}
                        onChange={(e) =>
                          store.updateCounterparty(primaryCpty.id, {
                            sector: e.target.value,
                            proxyKey: {
                              rating: primaryCpty.rating,
                              sector: e.target.value,
                              region: primaryCpty.region,
                            },
                          })
                        }
                      >
                        {['Mining', 'Corporate', 'Utilities', 'Retail', 'Bank', 'Sovereign'].map(
                          (sec) => (
                            <option key={sec} value={sec}>
                              {sec}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Recovery Rate R (LGD = 1 - R)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={0.05}
                        min={0}
                        max={0.95}
                        value={primaryCpty.recoveryRate}
                        onChange={(e) => {
                          const rec = Math.min(0.95, Math.max(0, Number(e.target.value) || 0.4));
                          store.updateCounterparty(primaryCpty.id, {
                            recoveryRate: rec,
                            creditCurve: primaryCpty.creditCurve
                              ? { ...primaryCpty.creditCurve, recoveryRate: rec }
                              : undefined,
                          });
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button
                      type="button"
                      className={`btn btn-sm ${primaryCpty.creditCurve ? 'val-signal' : ''}`}
                      onClick={() =>
                        store.updateCounterparty(primaryCpty.id, {
                          creditCurve: {
                            tenors: [1, 2, 3, 5, 7, 10],
                            cdsSpreads: [0.014, 0.0155, 0.017, 0.0185, 0.0195, 0.0205],
                            recoveryRate: primaryCpty.recoveryRate,
                          },
                        })
                      }
                    >
                      Usar Curva CDS Directa (185 bps 5Y)
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${!primaryCpty.creditCurve ? 'val-signal' : ''}`}
                      onClick={() =>
                        store.updateCounterparty(primaryCpty.id, {
                          creditCurve: undefined,
                          proxyKey: {
                            rating: primaryCpty.rating,
                            sector: primaryCpty.sector,
                            region: primaryCpty.region || 'Chile',
                          },
                        })
                      }
                    >
                      Usar Sólo Mapeo Proxy (Sin CDS Líquido)
                    </button>
                  </div>

                  <div className="gregory-callout">
                    <strong>Probabilidades Risk-Neutral vs Real-World (Gregory Cap. 12 / IFRS 13):</strong>{' '}
                    Los auditores y reguladores bajo IFRS 13 exigen extraer las probabilidades de
                    default desde spreads de crédito o proxies de mercado (risk-neutral), porque ese
                    spread incorpora la prima por riesgo sistemático y el costo real de cubrir el
                    CS01 del portafolio.
                  </div>
                </div>

                {/* Tabla de Hazard Rate y Supervivencia Bootstrapped */}
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h3 className="panel-title">
                        Bootstrap de Intensidad de Default λ(t) y Supervivencia S(t)
                      </h3>
                      <p className="panel-subtitle">
                        Triángulo del crédito por tramos constantes: λ ≈ Spread / (1 - R), S(t) =
                        exp(-∫λ(u)du).
                      </p>
                    </div>
                  </div>

                  <CreditHazardTable cpty={primaryCpty} ownBank={ownBank} />
                </div>
              </div>
            )}

            {/* ==================== PASO 3: COLATERAL / CSA ==================== */}
            {wizardStep === 3 && (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h2 className="panel-title">
                        Paso 3 — Acuerdo de Colateral (CSA Bilateral, MPOR e Initial Margin)
                      </h2>
                      <p className="panel-subtitle">
                        Configura Thresholds, Minimum Transfer Amount (aditivo), Margin Period of
                        Risk (lookback t - MPOR) e Initial Margin segregado.
                      </p>
                    </div>
                    <span className="book-badge">Gregory Cap. 6, 11 &amp; 15</span>
                  </div>

                  <div className="form-grid">
                    <div className="field-group">
                      <label className="field-label">Modalidad CSA Global</label>
                      <select
                        className="select-control"
                        value={globalCsa.type}
                        onChange={(e) =>
                          store.updateCSA(globalCsa.id, {
                            type: e.target.value as 'NO_CSA' | 'ONE_WAY' | 'TWO_WAY',
                          })
                        }
                      >
                        <option value="TWO_WAY">TWO_WAY (Bilateral Estándar)</option>
                        <option value="ONE_WAY">ONE_WAY (Unilateral a Nuestro Favor)</option>
                        <option value="NO_CSA">NO_CSA (Sin Colateral)</option>
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Threshold Contraparte H_cpty (UF)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={1000}
                        min={0}
                        value={
                          Number.isFinite(globalCsa.thresholdCpty) ? globalCsa.thresholdCpty : 0
                        }
                        onChange={(e) =>
                          store.updateCSA(globalCsa.id, {
                            thresholdCpty: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Threshold Propio H_own (UF)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={1000}
                        min={0}
                        value={Number.isFinite(globalCsa.thresholdOwn) ? globalCsa.thresholdOwn : 0}
                        onChange={(e) =>
                          store.updateCSA(globalCsa.id, {
                            thresholdOwn: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Minimum Transfer Amount MTA (UF)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={100}
                        min={0}
                        value={globalCsa.mta}
                        onChange={(e) =>
                          store.updateCSA(globalCsa.id, {
                            mta: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Margin Period of Risk MPOR (Días)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={1}
                        min={0}
                        max={60}
                        value={globalCsa.mporDays}
                        onChange={(e) =>
                          store.updateCSA(globalCsa.id, {
                            mporDays: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Initial Margin Segregado (UF)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={500}
                        min={0}
                        value={globalCsa.initialMargin}
                        onChange={(e) =>
                          store.updateCSA(globalCsa.id, {
                            initialMargin: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="gregory-callout">
                    <strong>Initial Margin Segregado (Gregory Cap. 11 y Cap. 15):</strong> El IM
                    segregado reduce la exposición positiva al default (menor CVA), pero como no
                    puede rehipotecarse, <strong>no reduce el ENE ni genera beneficio FBA</strong>, y
                    en cambio origina un costo de remuneración <strong>MVA</strong> (Cap. 16).
                  </div>
                </div>

                {/* Reporte de Settlement Spike Physical Delivery vs NDS */}
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h3 className="panel-title">
                        Riesgo de Liquidación: Entrega Física (Herstatt) vs Non-Deliverable Swap (NDS)
                      </h3>
                      <p className="panel-subtitle">
                        En CCS UF/CLP la modalidad Non-Deliverable (compensación por diferencia de
                        fixing) evita el spike de PFE 99% del nocional completo en fechas de intercambio.
                      </p>
                    </div>
                  </div>

                  <div className="grid-2">
                    <div className="kpi-card">
                      <span className="kpi-label">PFE 99% Entrega Física (2 días)</span>
                      <span className="kpi-value val-down">
                        {(output.settlementSpike.physical_pfe_99 / 1_000_000).toLocaleString(
                          'es-CL',
                          { maximumFractionDigits: 1 },
                        )}{' '}
                        MM CLP
                      </span>
                      <span className="kpi-sub">Exposición al principal completo + difusión</span>
                    </div>
                    <div className="kpi-card">
                      <span className="kpi-label">PFE 99% Compensación NDS (1 día)</span>
                      <span className="kpi-value val-up">
                        {(output.settlementSpike.nds_pfe_99 / 1_000_000).toLocaleString('es-CL', {
                          maximumFractionDigits: 1,
                        })}{' '}
                        MM CLP
                      </span>
                      <span className="kpi-sub">
                        Ratio de reducción:{' '}
                        <strong>{output.settlementSpike.spike_ratio.toFixed(1)}x menor</strong>
                      </span>
                    </div>
                  </div>

                  <div className="kpi-card">
                    <span className="kpi-label">Efecto del CSA Actual sobre Exposición (EPE)</span>
                    <span className="kpi-value val-signal">
                      {fmtUF(output.exposureProfile.epe)} vs{' '}
                      {fmtUF(output.exposureProfile.epeUncollateralized)} (Sin CSA)
                    </span>
                    <span className="kpi-sub">
                      Reducción de EPE por CSA:{' '}
                      <strong>
                        {(
                          (1 -
                            output.exposureProfile.epe /
                              Math.max(1, output.exposureProfile.epeUncollateralized)) *
                          100
                        ).toFixed(1)}
                        %
                      </strong>{' '}
                      · Effective EPE (1Y): {fmtUF(output.exposureProfile.eepe)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== PASO 4: PRODUCTOS & PORTAFOLIO ==================== */}
            {wizardStep === 4 && (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h2 className="panel-title">
                        Paso 4 — Portafolio de Operaciones y Regla Global CSA vs Override Puntual
                      </h2>
                      <p className="panel-subtitle">
                        Un acuerdo puntual (<code>csaOverrideId</code>) en una operación pisa al CSA
                        Global y segrega la operación en su propio Netting Set (FR-7.2).
                      </p>
                    </div>
                    <span className="book-badge">Gregory Cap. 5, 6 &amp; 7</span>
                  </div>

                  <div className="table-wrap">
                    <table className="quant-table">
                      <thead>
                        <tr>
                          <th>ID Trade</th>
                          <th>Producto</th>
                          <th>Dirección</th>
                          <th>Nocional UF</th>
                          <th>Madurez</th>
                          <th>Regla CSA Aplicada (FR-7.2)</th>
                          <th>Acción</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scenario.portfolio.trades.map((trd) => (
                          <tr key={trd.id}>
                            <td className="mono">{trd.id}</td>
                            <td className="mono val-signal">{trd.product}</td>
                            <td className="mono">{trd.direction}</td>
                            <td className="num">
                              {trd.product === 'CCS_UF_CLP'
                                ? fmtUF(trd.notionalUF, 0)
                                : fmtUF(trd.notional, 0)}
                            </td>
                            <td className="num">{trd.maturityYears.toFixed(1)}Y</td>
                            <td>
                              <select
                                className="select-control"
                                value={trd.csaOverrideId ?? ''}
                                onChange={(e) =>
                                  store.setTradeCsaOverride(trd.id, e.target.value || undefined)
                                }
                              >
                                <option value="">
                                  Heredar CSA Global ({globalCsa.id} · H=
                                  {globalCsa.thresholdCpty} UF)
                                </option>
                                {scenario.portfolio.csas
                                  .filter((c) => c.id !== globalCsa.id)
                                  .map((c) => (
                                    <option key={c.id} value={c.id}>
                                      Override Puntual: {c.id} ({c.type}, H={c.thresholdCpty} UF)
                                    </option>
                                  ))}
                              </select>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={scenario.portfolio.trades.length <= 1}
                                onClick={() => store.removeTrade(trd.id)}
                              >
                                Eliminar
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="gregory-callout">
                    <strong>Netting Sets Activos ({scenario.portfolio.nettingSets.length}):</strong>{' '}
                    {scenario.portfolio.nettingSets
                      .map((ns) => `${ns.id} [CSA: ${ns.csaId}, Trades: ${ns.tradeIds.length}]`)
                      .join(' · ')}
                  </div>
                </div>

                {/* Agregar Operación + Config Monte Carlo */}
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h3 className="panel-title">
                        Agregar Operación al Portafolio y Configuración Monte Carlo
                      </h3>
                      <p className="panel-subtitle">
                        Prueba el beneficio de netting agregando un swap en dirección opuesta (PAY vs
                        RECEIVE) o con distinta madurez.
                      </p>
                    </div>
                  </div>

                  <div className="form-grid">
                    <div className="field-group">
                      <label className="field-label">Producto OTC</label>
                      <select
                        className="select-control"
                        value={newProduct}
                        onChange={(e) => setNewProduct(e.target.value as ProductType)}
                      >
                        <option value="CCS_UF_CLP">CCS_UF_CLP (Cross-Currency UF/CLP)</option>
                        <option value="IRS">IRS (Swap Tasa Fija vs CAMARA)</option>
                        <option value="FX_FORWARD">FX_FORWARD (Forward UF/CLP)</option>
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">Nocional (UF)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={50000}
                        min={1000}
                        value={newNotionalUF}
                        onChange={(e) => setNewNotionalUF(Math.max(1000, Number(e.target.value)))}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Madurez (Años)</label>
                      <input
                        type="number"
                        className="input-control"
                        step={0.5}
                        min={0.5}
                        max={30}
                        value={newMaturity}
                        onChange={(e) => setNewMaturity(Math.max(0.5, Number(e.target.value)))}
                      />
                    </div>
                    <div className="field-group">
                      <label className="field-label">Dirección</label>
                      <select
                        className="select-control"
                        value={newDirection}
                        onChange={(e) => setNewDirection(e.target.value as Direction)}
                      >
                        <option value="RECEIVE">RECEIVE (Recibe UF / Paga CLP)</option>
                        <option value="PAY">PAY (Paga UF / Recibe CLP)</option>
                      </select>
                    </div>
                    <div className="field-group">
                      <label className="field-label">CSA (Global o Puntual)</label>
                      <select
                        className="select-control"
                        value={newCsaOverride}
                        onChange={(e) => setNewCsaOverride(e.target.value)}
                      >
                        <option value="">Usar CSA Global</option>
                        <option value="csa_trade_zero_threshold">
                          Override: Zero Threshold (H=0)
                        </option>
                        <option value="csa_none">Override: Sin CSA (Uncollateralized)</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <button
                      type="button"
                      className="btn-signal-primary"
                      onClick={() => {
                        const id = `trd_${newProduct.toLowerCase()}_${Date.now().toString().slice(-4)}`;
                        const spotFx = scenario.market.fxSpot.UFCLP ?? 38000;
                        const trade =
                          newProduct === 'CCS_UF_CLP'
                            ? createTrade({
                                id,
                                counterpartyId: primaryCpty.id,
                                product: 'CCS_UF_CLP',
                                notional: newNotionalUF,
                                notionalUF: newNotionalUF,
                                currency: 'UF',
                                maturityYears: newMaturity,
                                direction: newDirection,
                                ufClpFxFixed: spotFx,
                                csaOverrideId: newCsaOverride || undefined,
                              })
                            : newProduct === 'IRS'
                              ? createTrade({
                                  id,
                                  counterpartyId: primaryCpty.id,
                                  product: 'IRS',
                                  notional: newNotionalUF,
                                  currency: 'UF',
                                  maturityYears: newMaturity,
                                  direction: newDirection,
                                  fixedRate: 0.0495,
                                  csaOverrideId: newCsaOverride || undefined,
                                })
                              : createTrade({
                                  id,
                                  counterpartyId: primaryCpty.id,
                                  product: 'FX_FORWARD',
                                  notional: newNotionalUF,
                                  currency: 'UF',
                                  maturityYears: newMaturity,
                                  direction: newDirection,
                                  strikeFx: spotFx,
                                  csaOverrideId: newCsaOverride || undefined,
                                });
                        store.addTrade(trade);
                      }}
                    >
                      + Agregar Operación al Netting Set
                    </button>
                  </div>

                  <div
                    style={{
                      borderTop: '1px solid var(--border)',
                      paddingTop: 12,
                      marginTop: 6,
                    }}
                  >
                    <div className="form-grid">
                      <div className="field-group">
                        <label className="field-label">Trayectorias Monte Carlo (≤ 10,000)</label>
                        <input
                          type="number"
                          className="input-control"
                          step={200}
                          min={50}
                          max={10000}
                          value={scenario.mc.numPaths}
                          onChange={(e) =>
                            store.updateMonteCarloConfig({ numPaths: Number(e.target.value) || 500 })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label">Pasos por Año (Grilla Temporal)</label>
                        <input
                          type="number"
                          className="input-control"
                          step={1}
                          min={1}
                          max={12}
                          value={scenario.mc.gridPointsPerYear}
                          onChange={(e) =>
                            store.updateMonteCarloConfig({
                              gridPointsPerYear: Number(e.target.value) || 2,
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label">Semilla PRNG Determinista (NFR-3)</label>
                        <input
                          type="number"
                          className="input-control"
                          step={1}
                          value={scenario.mc.seed}
                          onChange={(e) =>
                            store.updateMonteCarloConfig({ seed: Number(e.target.value) || 42 })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== PASO 5: RESULTADOS, WATERFALL, WWR & COBERTURA ==================== */}
            {wizardStep === 5 && (
              <>
                {/* Dos Tarjetas Hero Separadas: Regla Dura Anti-Doble-Conteo (Gregory Cap. 14 y 15) */}
                <div className="grid-2">
                  <div className="kpi-card highlight-economic">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span className="kpi-label">
                        1. VISTA ECONÓMICA / PRICING (DVA EXCLUIDO — GREGORY CAP. 15)
                      </span>
                      <span className="pill pill-low">Anti-Doble-Conteo OK</span>
                    </div>
                    <div className="kpi-value val-signal">
                      net_xva = {fmtUF(output.xvaUF.net_xva)}
                    </div>
                    <div className="kpi-sub">
                      Fórmula: <code>-CVA ({fmtUF(-output.xvaUF.cva)}) - FCA ({fmtUF(-output.xvaUF.fca)}) + FBA (+{fmtUF(output.xvaUF.fba)})</code>{' '}
                      · Equivalente: <strong>{fmtCLP(output.xvaUF.net_xva, output.spotUfClp)}</strong>
                    </div>
                    <div className="kpi-sub">
                      All-In con MVA ({fmtUF(-output.xvaUF.mva)}) y KVA ({fmtUF(-output.xvaUF.kva)}):{' '}
                      <strong className="mono">{fmtUF(output.xvaUF.net_xva_all_in)}</strong>
                    </div>
                  </div>

                  <div className="kpi-card highlight-accounting">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span className="kpi-label">
                        2. VISTA CONTABLE / BALANCE IFRS 13 (GREGORY CAP. 14)
                      </span>
                      <span className="book-badge">IFRS 13 Fair Value</span>
                    </div>
                    <div className="kpi-value" style={{ color: '#a5b4fc' }}>
                      accounting_xva = {fmtUF(output.xvaUF.accounting_xva)}
                    </div>
                    <div className="kpi-sub">
                      Fórmula: <code>-CVA ({fmtUF(-output.xvaUF.cva)}) + DVA (+{fmtUF(output.xvaUF.dva)})</code>{' '}
                      · Equivalente:{' '}
                      <strong>{fmtCLP(output.xvaUF.accounting_xva, output.spotUfClp)}</strong>
                    </div>
                    <div className="kpi-sub">
                      <strong>Regla Dura:</strong> NUNCA se suman DVA (+{fmtUF(output.xvaUF.dva)}) y
                      FBA (+{fmtUF(output.xvaUF.fba)}) juntos porque ambos representan el beneficio
                      de fondeo de nuestro propio riesgo de default.
                    </div>
                  </div>
                </div>

                {/* Desglose de los 6 componentes XVA */}
                <div className="grid-4">
                  <div className="kpi-card">
                    <span className="kpi-label">CVA (Con CSA / Sin CSA)</span>
                    <span className="kpi-value val-down">-{fmtUF(output.xvaUF.cva)}</span>
                    <span className="kpi-sub">
                      Sin CSA: -{fmtUF(output.xvaUncollateralizedUF.cva)} · Benchmark demo.py: -
                      {fmtUF(output.demoBenchmarkUF.cva)}
                    </span>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-label">DVA (Sólo Vista Contable)</span>
                    <span className="kpi-value val-up">+{fmtUF(output.xvaUF.dva)}</span>
                    <span className="kpi-sub">
                      Benchmark demo.py: +{fmtUF(output.demoBenchmarkUF.dva)}
                    </span>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-label">FVA = FCA - FBA</span>
                    <span className="kpi-value val-warn">
                      -{fmtUF(output.xvaUF.fva)} (FCA {fmtUF(output.xvaUF.fca)} / FBA{' '}
                      {fmtUF(output.xvaUF.fba)})
                    </span>
                    <span className="kpi-sub">IM segregado excluido de FBA (Cap. 15)</span>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-label">MVA + KVA (Cap. 16)</span>
                    <span className="kpi-value val-down">
                      -{fmtUF(output.xvaUF.mva + output.xvaUF.kva)}
                    </span>
                    <span className="kpi-sub">
                      MVA: -{fmtUF(output.xvaUF.mva)} · KVA: -{fmtUF(output.xvaUF.kva)}
                    </span>
                  </div>
                </div>

                {/* Gráficos de Perfiles de Exposición (EE/ENE/PFE) y Waterfall XVA */}
                <div className="grid-2">
                  <div className="panel">
                    <div className="panel-header">
                      <div>
                        <h3 className="panel-title">
                          Perfiles de Exposición Temporal: EE(t), ENE(t), PFE 99%(t) y Efecto CSA
                        </h3>
                        <p className="panel-subtitle">
                          Comparación de Exposición Esperada con CSA (línea cian sólida) vs Sin
                          Colateral (línea punteada) y PFE 99%.
                        </p>
                      </div>
                      <span className="book-badge">Gregory Cap. 7 &amp; 11</span>
                    </div>
                    <ExposureProfileSvgChart profile={output.exposureProfile} />
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <div>
                        <h3 className="panel-title">
                          Waterfall XVA — Separación Estricta Pricing (`net_xva`) vs Contable (`accounting_xva`)
                        </h3>
                        <p className="panel-subtitle">
                          Visualización de cargos (-) y beneficios (+) en UF sin doble conteo DVA/FBA.
                        </p>
                      </div>
                      <span className="book-badge">Gregory Cap. 14, 15 &amp; 16</span>
                    </div>
                    <XvaWaterfallSvgChart xva={output.xvaUF} />
                  </div>
                </div>

                {/* Wrong-Way Risk (Fase 6) + QuickSens 3D Sliders */}
                <div className="grid-2">
                  <div className="panel">
                    <div className="panel-header">
                      <div>
                        <h3 className="panel-title">
                          Fase 6 — Wrong-Way Risk (WWR) Paramétrico (Correlación Exposición-Crédito ρ)
                        </h3>
                        <p className="panel-subtitle">
                          En un CCS UF/CLP donde el corporativo paga UF, una aceleración inflacionaria
                          eleva simultáneamente nuestra exposición EE(t) y la probabilidad de default
                          del cliente (ρ &gt; 0 ⇒ CVA_WWR &gt; CVA_base).
                        </p>
                      </div>
                      <span className="book-badge">Gregory Cap. 17 — WWR</span>
                    </div>

                    <div className="field-group">
                      <label className="field-label">
                        Correlación WWR ρ ={' '}
                        <strong className="val-signal">{store.wwrCorrelation.toFixed(2)}</strong> ·
                        Incremento WWR sobre CVA:{' '}
                        <strong className="val-down">
                          {output.xvaUF.wwr_Increment >= 0 ? '+' : ''}
                          {fmtUF(output.xvaUF.wwr_Increment)}
                        </strong>
                      </label>
                      <input
                        type="range"
                        min={-0.8}
                        max={0.9}
                        step={0.05}
                        value={store.wwrCorrelation}
                        onChange={(e) => store.setWwrCorrelation(Number(e.target.value))}
                      />
                    </div>

                    <div className="table-wrap">
                      <table className="quant-table">
                        <thead>
                          <tr>
                            <th>ρ (Correlación)</th>
                            <th>Régimen</th>
                            <th>CVA(ρ) en UF</th>
                            <th>net_xva(ρ) en UF</th>
                          </tr>
                        </thead>
                        <tbody>
                          {output.wwrCurve.map((pt) => (
                            <tr key={pt.rho}>
                              <td className="num">{pt.rho.toFixed(2)}</td>
                              <td>
                                {pt.rho < 0 ? (
                                  <span className="pill pill-low">Right-Way Risk</span>
                                ) : pt.rho === 0 ? (
                                  <span className="pill pill-medium">Independiente (Base)</span>
                                ) : (
                                  <span className="pill pill-high">Wrong-Way Risk</span>
                                )}
                              </td>
                              <td className="num">{fmtUF(pt.cvaUF)}</td>
                              <td className="num val-down">{fmtUF(pt.netXvaUF)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* QuickSens 3D Instant Interpolator */}
                  <div className="panel">
                    <div className="panel-header">
                      <div>
                        <h3 className="panel-title">
                          QuickSens 3D — Interpolación Trilineal Instantánea (&lt; 1 ms)
                        </h3>
                        <p className="panel-subtitle">
                          Explora shocks conjuntos en Curva UF, Curva CLP y Spot UF/CLP sobre la
                          grilla pre-computada 7×7×7.
                        </p>
                      </div>
                      <span className="book-badge">QuickSens 3D Grid</span>
                    </div>

                    <div className="form-grid">
                      <div className="field-group">
                        <label className="field-label">
                          Shift CAMARA_UF: {store.quickSensShift.ufShiftBps} bps
                        </label>
                        <input
                          type="range"
                          min={-150}
                          max={150}
                          step={5}
                          value={store.quickSensShift.ufShiftBps}
                          onChange={(e) =>
                            store.setQuickSensShift({ ufShiftBps: Number(e.target.value) })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label">
                          Shift CAMARA_CLP: {store.quickSensShift.clpShiftBps} bps
                        </label>
                        <input
                          type="range"
                          min={-200}
                          max={200}
                          step={5}
                          value={store.quickSensShift.clpShiftBps}
                          onChange={(e) =>
                            store.setQuickSensShift({ clpShiftBps: Number(e.target.value) })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label">
                          Shock FX UF/CLP: {(store.quickSensShift.fxSpotPct * 100).toFixed(1)}%
                        </label>
                        <input
                          type="range"
                          min={-0.1}
                          max={0.1}
                          step={0.01}
                          value={store.quickSensShift.fxSpotPct}
                          onChange={(e) =>
                            store.setQuickSensShift({ fxSpotPct: Number(e.target.value) })
                          }
                        />
                      </div>
                    </div>

                    <div className="kpi-card highlight-economic">
                      <span className="kpi-label">net_xva Interpolado en Grilla QuickSens 3D</span>
                      <span className="kpi-value val-signal">
                        {fmtUF(
                          interpolateQuickSens(
                            output.quickSensGrid,
                            store.quickSensShift.ufShiftBps,
                            store.quickSensShift.clpShiftBps,
                            store.quickSensShift.fxSpotPct,
                          ),
                        )}
                      </span>
                      <span className="kpi-sub">
                        Carry UF vs CLP (1Y):{' '}
                        <strong>{output.inflationCarryCheck.carry_bps.toFixed(1)} bps</strong> —{' '}
                        {output.inflationCarryCheck.recommendation}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Recomendaciones de Cobertura de Greeks XVA (FR-6.2 & FR-6.3) */}
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h3 className="panel-title">
                        Fase 7 — Estrategias de Cobertura de Greeks XVA (CS01, Vega, Rate DV01, FX
                        Delta)
                      </h3>
                      <p className="panel-subtitle">
                        Cada recomendación cuantifica el deterioro esperado sin cobertura vs el costo
                        estimado de cubrir hoy e incluye su regla explícita de Jon Gregory (haz clic
                        en &ldquo;Explicar&rdquo;).
                      </p>
                    </div>
                    <span className="book-badge">Gregory Cap. 12, 14 &amp; 18</span>
                  </div>

                  <div className="table-wrap">
                    <table className="quant-table">
                      <thead>
                        <tr>
                          <th>Greek</th>
                          <th>Sensibilidad</th>
                          <th>Acción Recomendada</th>
                          <th>Instrumento Sugerido</th>
                          <th>Deterioro Stress (Sin Hedge)</th>
                          <th>Costo Cobertura Hoy</th>
                          <th>Fundamento</th>
                        </tr>
                      </thead>
                      <tbody>
                        {output.hedgeRecommendations.map((rec) => (
                          <tr key={rec.id}>
                            <td className="mono val-signal">{rec.greek}</td>
                            <td className="num">
                              {rec.greekValue.toFixed(2)} <small>{rec.unit}</small>
                            </td>
                            <td>
                              <strong>{rec.action}</strong>
                            </td>
                            <td>{rec.instrument}</td>
                            <td className="num val-down">
                              -{fmtUF(rec.projectedDeteriorationUF)}
                            </td>
                            <td className="num val-warn">{fmtUF(rec.estimatedHedgeCostUF)}</td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setSelectedHedgeModal(rec)}
                              >
                                Explicar ({rec.bookChapter.split('—')[0].trim()})
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Semáforo de Riesgo DV01 por Tenor */}
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h3 className="panel-title">Semáforo de Riesgo DV01 por Tenor (CLP / bp)</h3>
                      <p className="panel-subtitle">
                        Sensibilidades analíticas por nodo de curva y recomendación de Spread Trades.
                      </p>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table className="quant-table">
                      <thead>
                        <tr>
                          <th>Tenor</th>
                          <th>DV01 (CLP / bp)</th>
                          <th>Nivel de Riesgo</th>
                          <th>Acción Mesa de Tasas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {output.semaphoreTable.map((row) => (
                          <tr key={row.tenor}>
                            <td className="num">{row.tenor.toFixed(2)}Y</td>
                            <td className="num">
                              {row.dv01.toLocaleString('es-CL', { maximumFractionDigits: 0 })} CLP
                            </td>
                            <td>
                              <span
                                className={`pill ${
                                  row.level === 'HIGH'
                                    ? 'pill-high'
                                    : row.level === 'MEDIUM'
                                      ? 'pill-medium'
                                      : 'pill-low'
                                }`}
                              >
                                {row.level}
                              </span>
                            </td>
                            <td>{row.action}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* Footer de Navegación del Wizard */}
            <div className="wizard-footer-nav">
              <button
                type="button"
                className="btn"
                disabled={wizardStep === 1}
                onClick={() => store.setWizardStep(Math.max(1, wizardStep - 1) as WizardStep)}
              >
                ← Paso Anterior
              </button>
              <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                Paso {wizardStep} de 5 · Tiempo de cómputo: {output.elapsedMs} ms
              </span>
              <button
                type="button"
                className="btn-signal-primary"
                disabled={wizardStep === 5}
                onClick={() => store.setWizardStep(Math.min(5, wizardStep + 1) as WizardStep)}
              >
                Siguiente Paso →
              </button>
            </div>
          </main>

          {/* Modal de Explicación Cuantitativa (FR-6.3) */}
          {selectedHedgeModal && (
            <div className="modal-overlay" onClick={() => setSelectedHedgeModal(null)}>
              <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="panel-header">
                  <div>
                    <h3 className="panel-title">
                      Fundamento Cuantitativo — Cobertura de {selectedHedgeModal.greek}
                    </h3>
                    <p className="panel-subtitle">{selectedHedgeModal.bookChapter}</p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setSelectedHedgeModal(null)}
                  >
                    Cerrar ✕
                  </button>
                </div>

                <div>
                  <div className="field-label">Acción Sugerida</div>
                  <div style={{ fontWeight: 700, color: 'var(--signal)', marginTop: 4 }}>
                    {selectedHedgeModal.action}
                  </div>
                </div>

                <div className="gregory-callout">
                  <strong>Regla del Libro (Jon Gregory):</strong> {selectedHedgeModal.bookRule}
                </div>

                <div className="gregory-callout" style={{ borderLeftColor: '#818cf8' }}>
                  <strong>Criterio Contable IFRS 13 vs Económico:</strong>{' '}
                  {selectedHedgeModal.accountingNote}
                </div>

                <div className="grid-2">
                  <div className="kpi-card">
                    <span className="kpi-label">Deterioro Proyectado Sin Cobertura</span>
                    <span className="kpi-value val-down">
                      -{fmtUF(selectedHedgeModal.projectedDeteriorationUF)}
                    </span>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-label">Costo Estimado de Ejecución Hoy</span>
                    <span className="kpi-value val-warn">
                      {fmtUF(selectedHedgeModal.estimatedHedgeCostUF)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </AuthGate>
  );
};

/* ==================== SUBCOMPONENTES VISUALES SVG ==================== */

const ZeroCurvesSvgChart: React.FC<{ curves: CurveSet }> = ({ curves }) => {
  const width = 560;
  const height = 220;
  const padL = 42;
  const padR = 18;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const sampleT = Array.from({ length: 60 }, (_, i) => 0.25 + (i / 59) * 29.75);
  const xOf = (t: number) => padL + (t / 30) * plotW;
  const yOf = (rPct: number) => padT + plotH - (rPct / 7.0) * plotH;

  const buildPath = (fn: (t: number) => number) =>
    sampleT
      .map((t, i) => `${i === 0 ? 'M' : 'L'} ${xOf(t).toFixed(1)} ${yOf(fn(t) * 100).toFixed(1)}`)
      .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {[1, 2, 3, 4, 5, 6].map((pct) => (
        <g key={pct}>
          <line
            x1={padL}
            y1={yOf(pct)}
            x2={width - padR}
            y2={yOf(pct)}
            stroke="#1b2634"
            strokeDasharray="3 3"
          />
          <text x={padL - 6} y={yOf(pct) + 4} fill="#9FB0BF" fontSize="10" textAnchor="end">
            {pct}%
          </text>
        </g>
      ))}
      <path d={buildPath((t) => curves.camara_clp.zeroRate(t))} fill="none" stroke="#F2574C" strokeWidth="2.2" />
      <path d={buildPath((t) => curves.sofr.zeroRate(t))} fill="none" stroke="#34D399" strokeWidth="2.2" />
      <path d={buildPath((t) => curves.camara_uf.zeroRate(t))} fill="none" stroke="#2FD9E8" strokeWidth="2.5" />
      <text x={width - 140} y={28} fill="#F2574C" fontSize="11" fontFamily="JetBrains Mono">
        ● CAMARA_CLP
      </text>
      <text x={width - 140} y={44} fill="#34D399" fontSize="11" fontFamily="JetBrains Mono">
        ● SOFR (USD)
      </text>
      <text x={width - 140} y={60} fill="#2FD9E8" fontSize="11" fontFamily="JetBrains Mono">
        ● CAMARA_UF
      </text>
    </svg>
  );
};

const CreditHazardTable: React.FC<{
  cpty: ReturnType<typeof useXvaStore.getState>['scenario']['portfolio']['counterparties'][0];
  ownBank: ReturnType<typeof useXvaStore.getState>['scenario']['portfolio']['counterparties'][0];
}> = ({ cpty, ownBank }) => {
  const cptyHazard = resolveCounterpartyHazardCurve(cpty);
  const ownHazard = resolveCounterpartyHazardCurve(ownBank);
  const horizons = [1, 2, 3, 5, 7, 10];

  return (
    <div className="table-wrap">
      <table className="quant-table">
        <thead>
          <tr>
            <th>Tenor</th>
            <th>λ Contraparte (bps)</th>
            <th>Supervivencia S_cpty(t)</th>
            <th>PD Acumulada Cpty</th>
            <th>λ Banco Propio (bps)</th>
            <th>Supervivencia S_own(t)</th>
          </tr>
        </thead>
        <tbody>
          {horizons.map((t) => {
            const sC = cptyHazard.survivalProbability(t);
            const sO = ownHazard.survivalProbability(t);
            return (
              <tr key={t}>
                <td className="num">{t}Y</td>
                <td className="num val-signal">
                  {(cptyHazard.hazardRateAt(t) * 10000).toFixed(1)} bps
                </td>
                <td className="num">{(sC * 100).toFixed(2)}%</td>
                <td className="num val-down">{((1 - sC) * 100).toFixed(2)}%</td>
                <td className="num">{(ownHazard.hazardRateAt(t) * 10000).toFixed(1)} bps</td>
                <td className="num val-up">{(sO * 100).toFixed(2)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const ExposureProfileSvgChart: React.FC<{
  profile: ReturnType<typeof useXvaStore.getState>['output']['exposureProfile'];
}> = ({ profile }) => {
  const width = 560;
  const height = 220;
  const padL = 54;
  const padR = 18;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxT = Math.max(...profile.times, 1);
  const maxVal = Math.max(...profile.pfeUncollateralized, ...profile.eeUncollateralized, 1000);

  const xOf = (t: number) => padL + (t / maxT) * plotW;
  const yOf = (v: number) => padT + plotH - Math.min(1, Math.max(0, v / maxVal)) * plotH;

  const buildLine = (arr: readonly number[]) =>
    profile.times
      .map((t, i) => `${i === 0 ? 'M' : 'L'} ${xOf(t).toFixed(1)} ${yOf(arr[i]).toFixed(1)}`)
      .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {[0.25, 0.5, 0.75, 1.0].map((f) => (
        <g key={f}>
          <line
            x1={padL}
            y1={yOf(maxVal * f)}
            x2={width - padR}
            y2={yOf(maxVal * f)}
            stroke="#1b2634"
            strokeDasharray="3 3"
          />
          <text
            x={padL - 6}
            y={yOf(maxVal * f) + 4}
            fill="#9FB0BF"
            fontSize="9.5"
            textAnchor="end"
          >
            {Math.round((maxVal * f) / 1000)}k
          </text>
        </g>
      ))}
      <path
        d={buildLine(profile.pfe)}
        fill="none"
        stroke="#FBBF24"
        strokeWidth="1.8"
        strokeDasharray="4 3"
      />
      <path
        d={buildLine(profile.eeUncollateralized)}
        fill="none"
        stroke="#9FB0BF"
        strokeWidth="1.8"
        strokeDasharray="2 2"
      />
      <path d={buildLine(profile.ee)} fill="none" stroke="#2FD9E8" strokeWidth="2.8" />
      <path d={buildLine(profile.ene)} fill="none" stroke="#34D399" strokeWidth="2.0" />
      <text x={padL + 10} y={28} fill="#2FD9E8" fontSize="10.5" fontFamily="JetBrains Mono">
        ━ EE(t) Con CSA
      </text>
      <text x={padL + 135} y={28} fill="#9FB0BF" fontSize="10.5" fontFamily="JetBrains Mono">
        ┅ EE Sin CSA
      </text>
      <text x={padL + 245} y={28} fill="#FBBF24" fontSize="10.5" fontFamily="JetBrains Mono">
        ╍ PFE 99%
      </text>
      <text x={padL + 340} y={28} fill="#34D399" fontSize="10.5" fontFamily="JetBrains Mono">
        ━ ENE(t)
      </text>
    </svg>
  );
};

const XvaWaterfallSvgChart: React.FC<{
  xva: ReturnType<typeof useXvaStore.getState>['output']['xvaUF'];
}> = ({ xva }) => {
  const bars = [
    { label: '-CVA', val: -xva.cva, color: '#F2574C' },
    { label: '-FCA', val: -xva.fca, color: '#F2574C' },
    { label: '+FBA', val: xva.fba, color: '#34D399' },
    { label: 'net_xva (Pricing)', val: xva.net_xva, color: '#2FD9E8' },
    { label: '+DVA (Contable)', val: xva.dva, color: '#818cf8' },
    { label: 'accounting_xva', val: xva.accounting_xva, color: '#a5b4fc' },
  ];

  const width = 560;
  const height = 220;
  const midY = 110;
  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.val)), 500);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      <line x1={24} y1={midY} x2={width - 20} y2={midY} stroke="#22303F" strokeWidth="1.5" />
      {bars.map((b, idx) => {
        const x = 35 + idx * 86;
        const barH = Math.max(4, (Math.abs(b.val) / maxAbs) * 75);
        const y = b.val >= 0 ? midY - barH : midY;
        return (
          <g key={b.label}>
            <rect x={x} y={y} width={56} height={barH} rx={3} fill={b.color} opacity={0.9} />
            <text
              x={x + 28}
              y={b.val >= 0 ? y - 6 : y + barH + 13}
              fill="#E6ECF2"
              fontSize="10"
              fontFamily="JetBrains Mono"
              textAnchor="middle"
            >
              {b.val >= 0 ? '+' : ''}
              {Math.round(b.val)}
            </text>
            <text
              x={x + 28}
              y={height - 8}
              fill="#9FB0BF"
              fontSize="9.5"
              fontFamily="IBM Plex Sans"
              textAnchor="middle"
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
