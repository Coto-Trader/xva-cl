import { beforeEach, describe, expect, it } from 'vitest';
import { handleWorkerRequest, type WorkerResponseMessage } from '../src/engine/worker';
import { useXvaStore } from '../src/store/useXvaStore';

describe('Fase 8 — Zustand Store, Trade-Level CSA Override (FR-7.2), JSON Export/Import Roundtrip (FR-7.3) & Web Worker Protocol', () => {
  beforeEach(() => {
    useXvaStore.getState().resetToDefaultScenario();
  });

  it('FR-7.3 Acceptance: exported JSON scenario re-imported reproduces identical XVA results bit-for-bit (NFR-3)', () => {
    const store = useXvaStore.getState();

    // Modify market & WWR to create a customized scenario
    store.shiftCurveParallel('CAMARA_UF', 25);
    store.setWwrCorrelation(0.35);

    const beforeExport = useXvaStore.getState().output;
    const jsonExported = useXvaStore.getState().exportScenarioJson();

    // Reset store to default and verify output changed
    useXvaStore.getState().resetToDefaultScenario();
    expect(useXvaStore.getState().output.xvaUF.cva).not.toBe(beforeExport.xvaUF.cva);

    // Re-import JSON and set same WWR
    useXvaStore.getState().setWwrCorrelation(0.35);
    useXvaStore.getState().importScenarioJson(jsonExported);

    const afterImport = useXvaStore.getState().output;
    expect(afterImport.xvaUF.cva).toBe(beforeExport.xvaUF.cva);
    expect(afterImport.xvaUF.dva).toBe(beforeExport.xvaUF.dva);
    expect(afterImport.xvaUF.fca).toBe(beforeExport.xvaUF.fca);
    expect(afterImport.xvaUF.fba).toBe(beforeExport.xvaUF.fba);
    expect(afterImport.xvaUF.net_xva).toBe(beforeExport.xvaUF.net_xva);
    expect(afterImport.xvaUF.accounting_xva).toBe(beforeExport.xvaUF.accounting_xva);
    expect(afterImport.exposureProfile.epe).toBe(beforeExport.exposureProfile.epe);
  });

  it('FR-7.2 Acceptance: trade-level CSA override supersedes Global CSA and updates Netting Set exposure & CVA', () => {
    const initialOut = useXvaStore.getState().output;
    const tradeId = useXvaStore.getState().scenario.portfolio.trades[0].id;

    // Default uses csa_global_bilateral (threshold = 8,000 UF)
    expect(initialOut.nettingSetResults[0].effectiveCsaId).toBe('csa_global_bilateral');

    // Override trade with zero-threshold CSA (threshold = 0 UF, IM = 6,000 UF)
    useXvaStore.getState().setTradeCsaOverride(tradeId, 'csa_trade_zero_threshold');
    const zeroThreshOut = useXvaStore.getState().output;

    expect(zeroThreshOut.nettingSetResults[0].effectiveCsaId).toBe('csa_trade_zero_threshold');
    expect(zeroThreshOut.exposureProfile.epe).toBeLessThan(initialOut.exposureProfile.epe);
    expect(zeroThreshOut.xvaUF.cva).toBeLessThan(initialOut.xvaUF.cva);

    // Override trade with uncollateralized CSA (NO_CSA)
    useXvaStore.getState().setTradeCsaOverride(tradeId, 'csa_none');
    const noCsaOut = useXvaStore.getState().output;

    expect(noCsaOut.nettingSetResults[0].csaType).toBe('NO_CSA');
    expect(noCsaOut.xvaUF.cva).toBeGreaterThan(initialOut.xvaUF.cva);
  });

  it('processes RUN_PIPELINE messages in the Web Worker handler and emits PROGRESS + RESULT', () => {
    const scenario = useXvaStore.getState().scenario;
    const messages: WorkerResponseMessage[] = [];

    handleWorkerRequest(
      {
        type: 'RUN_PIPELINE',
        requestId: 'req_test_1',
        scenario,
        options: { wwrCorrelation: 0.20 },
      },
      (msg) => messages.push(msg),
    );

    const progressMsgs = messages.filter((m) => m.type === 'PROGRESS');
    const resultMsg = messages.find((m) => m.type === 'RESULT');

    expect(progressMsgs.length).toBeGreaterThanOrEqual(2);
    expect(resultMsg).toBeDefined();
    if (resultMsg && resultMsg.type === 'RESULT') {
      expect(resultMsg.output.xvaUF.cva).toBeGreaterThan(0);
    }
  });
});
