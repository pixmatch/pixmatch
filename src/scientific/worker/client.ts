import { BatchSession, validateRecipe } from '../execution/processBatch';
import type { BatchProgress, BatchRecipe, ExperimentResult, ImageFrame, MeasurementResult } from '../types';

/** Feeds frames to the engine one by one and returns the audited experiment when finished. */
export interface EngineRunner {
  /** 'worker' = background thread (UI stays responsive); 'main' = fallback when workers are unavailable. */
  readonly mode: 'worker' | 'main';
  /** In worker mode the frame's pixel buffer is transferred (the caller must not reuse it). */
  processFrame(frame: ImageFrame): Promise<MeasurementResult[]>;
  finish(): Promise<ExperimentResult>;
  dispose(): void;
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function mainThreadRunner(experimentId: string, recipe: BatchRecipe): EngineRunner {
  const session = new BatchSession(experimentId, recipe);
  return {
    mode: 'main',
    async processFrame(frame) { await tick(); return session.add(frame); },
    async finish() { return session.finish(); },
    dispose() { /* nothing to release */ },
  };
}

function startWorker(experimentId: string, recipe: BatchRecipe, timeoutMs: number): Promise<EngineRunner> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let ready = false;
    const fail = (error: Error) => {
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      if (!ready) { worker.terminate(); reject(error); }
    };
    const timer = setTimeout(() => fail(new Error('WORKER_START_TIMEOUT')), timeoutMs);
    worker.onerror = e => fail(Object.assign(new Error(e.message || 'WORKER_ERROR'), { name: 'WorkerError' }));
    worker.onmessage = (event: MessageEvent<any>) => {
      const m = event.data;
      if (m.type === 'READY') {
        ready = true; clearTimeout(timer);
        const call = <T,>(message: object, transfer: Transferable[] = []) => new Promise<T>((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          worker.postMessage({ ...message, id }, transfer);
        });
        resolve({
          mode: 'worker',
          processFrame: frame => call<MeasurementResult[]>({ type: 'FRAME', frame }, [frame.data.buffer]),
          finish: () => call<ExperimentResult>({ type: 'FINISH' }),
          dispose: () => { clearTimeout(timer); worker.terminate(); pending.clear(); },
        });
      } else if (m.type === 'ERROR' && m.id == null) {
        fail(new Error(m.error));
      } else {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === 'FRAME_RESULT') p.resolve(m.results);
        else if (m.type === 'RESULT') p.resolve(m.result);
        else p.reject(new Error(m.error));
      }
    };
    worker.postMessage({ type: 'INIT', experimentId, recipe });
  });
}

/**
 * Create a runner. The recipe is validated first (bad calibration etc. throws immediately). A worker is used when the
 * browser supports it and it starts within a few seconds; otherwise the same engine runs on the main thread.
 */
export async function createRunner(experimentId: string, recipe: BatchRecipe, opts: { forceMainThread?: boolean; workerTimeoutMs?: number } = {}): Promise<EngineRunner> {
  validateRecipe(recipe);
  if (!opts.forceMainThread && typeof Worker !== 'undefined') {
    try { return await startWorker(experimentId, recipe, opts.workerTimeoutMs ?? 8000); } catch { /* fall back below */ }
  }
  return mainThreadRunner(experimentId, recipe);
}

/** Convenience: run a whole array of frames (all already in memory). */
export async function runInWorker(
  experimentId: string, frames: ImageFrame[], recipe: BatchRecipe,
  opts: { onProgress?: (p: BatchProgress) => void; signal?: AbortSignal; forceMainThread?: boolean } = {},
): Promise<ExperimentResult> {
  const runner = await createRunner(experimentId, recipe, { forceMainThread: opts.forceMainThread });
  try {
    for (let i = 0; i < frames.length; i++) {
      if (opts.signal?.aborted) throw new Error('CANCELLED');
      const frameIndex = frames[i].frameIndex;
      await runner.processFrame(frames[i]);
      opts.onProgress?.({ done: i + 1, total: frames.length, frameIndex });
    }
    return await runner.finish();
  } finally { runner.dispose(); }
}
