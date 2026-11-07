/**
 * Fase 8 — Store Reactivo Zustand (`useXvaStore`) con Persistencia Local y Export/Import JSON.
 *
 * Cumple:
 * - FR-7.1: Flujo guiado en 5 pasos (1. Curvas · 2. Cliente · 3. Colateral/CSA · 4. Productos · 5. Resultados).
 * - FR-7.2: Regla Global CSA vs Trade-Level CSA Override (`csaOverrideId`), re-agrupando Netting Sets automáticamente.
 * - FR-7.3: Guardar/cargar escenarios en `localStorage['xvacl_scenarios']` y exportar/importar `.json`
 *   reproduciendo exactamente los mismos resultados XVA (NFR-3).
 */

import { create } from 'zustand';
import {
  buildNettingSets,
  validatePortfolio,
} from '../domain/builder';
import type {
  AnyTrade,
  Counterparty,
  CSA,
  CurveName,
  MonteCarloConfig,
  Portfolio,
  Scenario,
} from '../domain/types';
import {
  type XvaPipelineOutput,
  createDefaultSampleScenario,
  runFullXvaPipeline,
} from '../engine/pipeline';
import type { WorkerResponseMessage, WorkerRunRequest } from '../engine/worker';

export const SCENARIOS_STORAGE_KEY = 'xvacl_scenarios';

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export interface QuickSensShiftState {
  ufShiftBps: number;
  clpShiftBps: number;
  fxSpotPct: number;
}

export interface XvaStoreState {
  wizardStep: WizardStep;
  scenario: Scenario;
  savedScenarios: Scenario[];
  wwrCorrelation: number;
  costOfCapitalAnnual: number;
  quickSensShift: QuickSensShiftState;
  output: XvaPipelineOutput;
  isComputing: boolean;
  progressPercent: number;
  progressStage: string;
  error: string | null;

  setWizardStep: (step: WizardStep) => void;
  updateZeroCurveNode: (curveName: CurveName, index: number, zeroRate: number) => void;
  shiftCurveParallel: (curveName: CurveName, shiftBps: number) => void;
  updateMarketParams: (patch: {
    ufClpSpot?: number;
    ufClpVol?: number;
    fundingSpreadBps?: number;
  }) => void;
  updateCounterparty: (counterpartyId: string, patch: Partial<Counterparty>) => void;
  updateCSA: (csaId: string, patch: Partial<CSA>) => void;
  addTrade: (trade: AnyTrade) => void;
  updateTrade: (tradeId: string, patch: Partial<AnyTrade>) => void;
  removeTrade: (tradeId: string) => void;
  setTradeCsaOverride: (tradeId: string, csaOverrideId?: string) => void;
  updateMonteCarloConfig: (patch: Partial<MonteCarloConfig>) => void;
  setWwrCorrelation: (rho: number) => void;
  setCostOfCapitalAnnual: (coc: number) => void;
  setQuickSensShift: (patch: Partial<QuickSensShiftState>) => void;
  recomputeSync: () => XvaPipelineOutput;
  recomputeAsync: () => Promise<XvaPipelineOutput>;
  resetToDefaultScenario: () => void;
  saveCurrentScenario: (customName?: string) => Scenario;
  loadSavedScenario: (scenarioId: string) => void;
  deleteSavedScenario: (scenarioId: string) => void;
  exportScenarioJson: () => string;
  importScenarioJson: (jsonText: string) => Scenario;
}

function readSavedScenariosFromStorage(): Scenario[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(SCENARIOS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedScenariosToStorage(scenarios: Scenario[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SCENARIOS_STORAGE_KEY, JSON.stringify(scenarios));
  } catch {
    // Ignore storage quota errors in restricted environments
  }
}

function rebuildScenarioPortfolio(scenario: Scenario): Scenario {
  const rebuiltPortfolio: Portfolio = {
    counterparties: scenario.portfolio.counterparties,
    csas: scenario.portfolio.csas,
    trades: scenario.portfolio.trades,
    nettingSets: buildNettingSets({
      counterparties: scenario.portfolio.counterparties,
      csas: scenario.portfolio.csas,
      trades: scenario.portfolio.trades,
      nettingSets: [],
    }),
  };
  return {
    ...scenario,
    portfolio: rebuiltPortfolio,
  };
}

const initialScenario = createDefaultSampleScenario();
const initialOutput = runFullXvaPipeline(initialScenario, {
  wwrCorrelation: 0.0,
  costOfCapitalAnnual: 0.10,
});

export const useXvaStore = create<XvaStoreState>((set, get) => ({
  wizardStep: 1,
  scenario: initialScenario,
  savedScenarios: readSavedScenariosFromStorage(),
  wwrCorrelation: 0.0,
  costOfCapitalAnnual: 0.10,
  quickSensShift: {
    ufShiftBps: 0,
    clpShiftBps: 0,
    fxSpotPct: 0,
  },
  output: initialOutput,
  isComputing: false,
  progressPercent: 100,
  progressStage: 'Listo',
  error: null,

  setWizardStep: (step) => set({ wizardStep: step }),

  updateZeroCurveNode: (curveName, index, zeroRate) => {
    const cur = get().scenario;
    const curve = cur.market.curves[curveName];
    if (!curve || index < 0 || index >= curve.zeroRates.length) return;
    const nextRates = [...curve.zeroRates];
    nextRates[index] = zeroRate;
    const nextScenario: Scenario = {
      ...cur,
      market: {
        ...cur.market,
        curves: {
          ...cur.market.curves,
          [curveName]: {
            ...curve,
            zeroRates: nextRates,
          },
        },
      },
    };
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  shiftCurveParallel: (curveName, shiftBps) => {
    const cur = get().scenario;
    const curve = cur.market.curves[curveName];
    if (!curve) return;
    const shiftDec = shiftBps / 10_000.0;
    const nextRates = curve.zeroRates.map((r) => +(r + shiftDec).toFixed(6));
    const nextScenario: Scenario = {
      ...cur,
      market: {
        ...cur.market,
        curves: {
          ...cur.market.curves,
          [curveName]: {
            ...curve,
            zeroRates: nextRates,
          },
        },
      },
    };
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  updateMarketParams: (patch) => {
    const cur = get().scenario;
    const nextScenario: Scenario = {
      ...cur,
      market: {
        ...cur.market,
        fxSpot: {
          ...cur.market.fxSpot,
          ...(patch.ufClpSpot !== undefined ? { UFCLP: patch.ufClpSpot } : {}),
        },
        fxVol: {
          ...cur.market.fxVol,
          ...(patch.ufClpVol !== undefined ? { UFCLP: patch.ufClpVol } : {}),
        },
        fundingSpread:
          patch.fundingSpreadBps !== undefined
            ? patch.fundingSpreadBps / 10_000.0
            : cur.market.fundingSpread,
      },
    };
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  updateCounterparty: (counterpartyId, patch) => {
    const cur = get().scenario;
    const counterparties = cur.portfolio.counterparties.map((c) =>
      c.id === counterpartyId ? { ...c, ...patch } : c,
    );
    const nextScenario = rebuildScenarioPortfolio({
      ...cur,
      portfolio: {
        ...cur.portfolio,
        counterparties,
      },
    });
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  updateCSA: (csaId, patch) => {
    const cur = get().scenario;
    const csas = cur.portfolio.csas.map((c) => (c.id === csaId ? { ...c, ...patch } : c));
    const nextScenario = rebuildScenarioPortfolio({
      ...cur,
      portfolio: {
        ...cur.portfolio,
        csas,
      },
    });
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  addTrade: (trade) => {
    const cur = get().scenario;
    const nextScenario = rebuildScenarioPortfolio({
      ...cur,
      portfolio: {
        ...cur.portfolio,
        trades: [...cur.portfolio.trades, trade],
      },
    });
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  updateTrade: (tradeId, patch) => {
    const cur = get().scenario;
    const trades = cur.portfolio.trades.map((t) =>
      t.id === tradeId ? ({ ...t, ...patch } as AnyTrade) : t,
    );
    const nextScenario = rebuildScenarioPortfolio({
      ...cur,
      portfolio: {
        ...cur.portfolio,
        trades,
      },
    });
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  removeTrade: (tradeId) => {
    const cur = get().scenario;
    if (cur.portfolio.trades.length <= 1) return; // Mantener al menos 1 operación activa
    const trades = cur.portfolio.trades.filter((t) => t.id !== tradeId);
    const nextScenario = rebuildScenarioPortfolio({
      ...cur,
      portfolio: {
        ...cur.portfolio,
        trades,
      },
    });
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  setTradeCsaOverride: (tradeId, csaOverrideId) => {
    const cur = get().scenario;
    const trades = cur.portfolio.trades.map((t) =>
      t.id === tradeId ? ({ ...t, csaOverrideId: csaOverrideId || undefined } as AnyTrade) : t,
    );
    const nextScenario = rebuildScenarioPortfolio({
      ...cur,
      portfolio: {
        ...cur.portfolio,
        trades,
      },
    });
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  updateMonteCarloConfig: (patch) => {
    const cur = get().scenario;
    const nextScenario: Scenario = {
      ...cur,
      mc: {
        ...cur.mc,
        ...patch,
        numPaths: Math.max(10, Math.min(patch.numPaths ?? cur.mc.numPaths, 10_000)),
      },
    };
    const output = runFullXvaPipeline(nextScenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: nextScenario, output, error: null });
  },

  setWwrCorrelation: (rho) => {
    const clamped = Math.max(-1, Math.min(1, rho));
    const output = runFullXvaPipeline(get().scenario, {
      wwrCorrelation: clamped,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ wwrCorrelation: clamped, output, error: null });
  },

  setCostOfCapitalAnnual: (coc) => {
    const clamped = Math.max(0, Math.min(0.50, coc));
    const output = runFullXvaPipeline(get().scenario, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: clamped,
    });
    set({ costOfCapitalAnnual: clamped, output, error: null });
  },

  setQuickSensShift: (patch) => {
    set((state) => ({
      quickSensShift: {
        ...state.quickSensShift,
        ...patch,
      },
    }));
  },

  recomputeSync: () => {
    const state = get();
    set({ isComputing: true, progressPercent: 15, progressStage: 'Ejecutando simulación...' });
    const output = runFullXvaPipeline(state.scenario, {
      wwrCorrelation: state.wwrCorrelation,
      costOfCapitalAnnual: state.costOfCapitalAnnual,
      onProgress: (percent, stage) => {
        set({ progressPercent: percent, progressStage: stage });
      },
    });
    set({ output, isComputing: false, progressPercent: 100, progressStage: 'Listo', error: null });
    return output;
  },

  recomputeAsync: async () => {
    const state = get();
    if (typeof Worker === 'undefined') {
      return state.recomputeSync();
    }

    set({ isComputing: true, progressPercent: 5, progressStage: 'Iniciando Web Worker...' });

    return new Promise<XvaPipelineOutput>((resolve) => {
      try {
        const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), {
          type: 'module',
        });
        const requestId = `req_${Date.now()}`;
        const req: WorkerRunRequest = {
          type: 'RUN_PIPELINE',
          requestId,
          scenario: state.scenario,
          options: {
            wwrCorrelation: state.wwrCorrelation,
            costOfCapitalAnnual: state.costOfCapitalAnnual,
          },
        };

        worker.onmessage = (ev: MessageEvent<WorkerResponseMessage>) => {
          const msg = ev.data;
          if (!msg || msg.requestId !== requestId) return;
          if (msg.type === 'PROGRESS') {
            set({ progressPercent: msg.percent, progressStage: msg.stage });
          } else if (msg.type === 'RESULT') {
            worker.terminate();
            set({
              output: msg.output,
              isComputing: false,
              progressPercent: 100,
              progressStage: 'Listo',
              error: null,
            });
            resolve(msg.output);
          } else if (msg.type === 'ERROR') {
            worker.terminate();
            set({ isComputing: false, error: msg.error });
            resolve(state.recomputeSync());
          }
        };

        worker.onerror = () => {
          worker.terminate();
          resolve(state.recomputeSync());
        };

        worker.postMessage(req);
      } catch {
        resolve(state.recomputeSync());
      }
    });
  },

  resetToDefaultScenario: () => {
    const def = createDefaultSampleScenario();
    const output = runFullXvaPipeline(def, {
      wwrCorrelation: 0.0,
      costOfCapitalAnnual: 0.10,
    });
    set({
      scenario: def,
      wwrCorrelation: 0.0,
      costOfCapitalAnnual: 0.10,
      quickSensShift: { ufShiftBps: 0, clpShiftBps: 0, fxSpotPct: 0 },
      output,
      error: null,
    });
  },

  saveCurrentScenario: (customName) => {
    const state = get();
    const toSave: Scenario = {
      ...state.scenario,
      id: `scen_${Date.now()}`,
      name: (customName ?? state.scenario.name).trim() || 'Escenario Guardado',
      createdAt: new Date().toISOString(),
    };
    const nextList = [toSave, ...state.savedScenarios.filter((s) => s.id !== toSave.id)];
    writeSavedScenariosToStorage(nextList);
    set({ scenario: toSave, savedScenarios: nextList });
    return toSave;
  },

  loadSavedScenario: (scenarioId) => {
    const state = get();
    const found = state.savedScenarios.find((s) => s.id === scenarioId);
    if (!found) return;
    const rebuilt = rebuildScenarioPortfolio(found);
    const output = runFullXvaPipeline(rebuilt, {
      wwrCorrelation: state.wwrCorrelation,
      costOfCapitalAnnual: state.costOfCapitalAnnual,
    });
    set({ scenario: rebuilt, output, error: null });
  },

  deleteSavedScenario: (scenarioId) => {
    const state = get();
    const nextList = state.savedScenarios.filter((s) => s.id !== scenarioId);
    writeSavedScenariosToStorage(nextList);
    set({ savedScenarios: nextList });
  },

  exportScenarioJson: () => {
    return JSON.stringify(get().scenario, null, 2);
  },

  importScenarioJson: (jsonText) => {
    const parsed = JSON.parse(jsonText) as Scenario;
    if (!parsed || !parsed.market || !parsed.portfolio || !parsed.mc) {
      throw new Error('El archivo JSON no contiene un Scenario válido (market, portfolio, mc).');
    }
    const issues = validatePortfolio(parsed.portfolio);
    const errors = issues.filter((i) => i.severity === 'ERROR');
    if (errors.length > 0) {
      throw new Error(`Portafolio inválido al importar: ${errors[0].message}`);
    }
    const validated: Scenario = {
      id: parsed.id || `scen_${Date.now()}`,
      name: parsed.name || 'Escenario Importado',
      createdAt: parsed.createdAt || new Date().toISOString(),
      market: parsed.market,
      portfolio: rebuildScenarioPortfolio(parsed).portfolio,
      mc: parsed.mc,
    };
    const output = runFullXvaPipeline(validated, {
      wwrCorrelation: get().wwrCorrelation,
      costOfCapitalAnnual: get().costOfCapitalAnnual,
    });
    set({ scenario: validated, output, error: null });
    return validated;
  },
}));
