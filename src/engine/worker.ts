/**
 * Fase 8 — Web Worker para ejecución asíncrona del motor XVA en el navegador (NFR-1, NFR-2).
 *
 * Mantiene el hilo principal (UI) a 60 fps durante simulaciones Monte Carlo de hasta
 * 10,000 trayectorias y cálculo de sensibilidades bump-and-revalue.
 */

import type { Scenario } from '../domain/types';
import {
  type PipelineRunOptions,
  type XvaPipelineOutput,
  runFullXvaPipeline,
} from './pipeline';

export interface WorkerRunRequest {
  type: 'RUN_PIPELINE';
  requestId: string;
  scenario: Scenario;
  options?: Omit<PipelineRunOptions, 'onProgress'>;
}

export type WorkerResponseMessage =
  | {
      type: 'PROGRESS';
      requestId: string;
      percent: number;
      stage: string;
    }
  | {
      type: 'RESULT';
      requestId: string;
      output: XvaPipelineOutput;
    }
  | {
      type: 'ERROR';
      requestId: string;
      error: string;
    };

/**
 * Handler puro reutilizable tanto dentro del contexto Web Worker como en tests.
 */
export function handleWorkerRequest(
  msg: WorkerRunRequest,
  postMsg: (response: WorkerResponseMessage) => void,
): void {
  if (!msg || msg.type !== 'RUN_PIPELINE') return;
  try {
    const output = runFullXvaPipeline(msg.scenario, {
      ...msg.options,
      onProgress: (percent, stage) => {
        postMsg({
          type: 'PROGRESS',
          requestId: msg.requestId,
          percent,
          stage,
        });
      },
    });
    postMsg({
      type: 'RESULT',
      requestId: msg.requestId,
      output,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    postMsg({
      type: 'ERROR',
      requestId: msg.requestId,
      error: message,
    });
  }
}

// Registro automático cuando se ejecuta en contexto DedicatedWorkerGlobalScope
const globalScope = globalThis as unknown as {
  onmessage?: ((ev: MessageEvent<WorkerRunRequest>) => void) | null;
  postMessage?: (message: WorkerResponseMessage) => void;
};

if (typeof globalScope.postMessage === 'function' && typeof window === 'undefined') {
  globalScope.onmessage = (ev: MessageEvent<WorkerRunRequest>) => {
    handleWorkerRequest(ev.data, (resp) => {
      globalScope.postMessage?.(resp);
    });
  };
}
