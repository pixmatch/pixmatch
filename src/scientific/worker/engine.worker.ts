import { BatchSession } from '../execution/processBatch';
import type { BatchRecipe, ImageFrame } from '../types';

/**
 * Worker protocol (frames are streamed one at a time so the page never holds a second copy of the whole sequence):
 *   main → worker  INIT {experimentId, recipe}      worker → main  READY
 *   main → worker  FRAME {id, frame}                worker → main  FRAME_RESULT {id, results}
 *   main → worker  FINISH {id}                      worker → main  RESULT {id, result}
 * Any failure is reported as ERROR {id, error}.
 */
type In =
  | { type: 'INIT'; experimentId: string; recipe: BatchRecipe }
  | { type: 'FRAME'; id: number; frame: ImageFrame }
  | { type: 'FINISH'; id: number };

let session: BatchSession | null = null;
const post = (message: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(message);

self.onmessage = (event: MessageEvent<In>) => {
  const m = event.data;
  const id = 'id' in m ? m.id : undefined;
  try {
    if (m.type === 'INIT') {
      session = new BatchSession(m.experimentId, m.recipe);
      post({ type: 'READY' });
    } else if (m.type === 'FRAME') {
      if (!session) throw new Error('WORKER_NOT_INITIALISED');
      post({ type: 'FRAME_RESULT', id: m.id, results: session.add(m.frame) });
    } else if (m.type === 'FINISH') {
      if (!session) throw new Error('WORKER_NOT_INITIALISED');
      post({ type: 'RESULT', id: m.id, result: session.finish() });
    }
  } catch (error) {
    post({ type: 'ERROR', id, error: String((error as Error)?.message ?? error) });
  }
};
