// Face Landmarker in a Web Worker: loading the model, compiling the wasm and building the GPU
// graph (the first detect, about 2 s) no longer freeze the page, so the scan panel stays
// responsive while the detector starts and while it measures a photo.
// The network guard goes first: the page CSP does not reach this worker.
import './worker-net-guard';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, type LandmarkerStage } from './landmarker.core';

export type LandmarkerRequest = { id: number; type: 'init'; base: string } | { id: number; type: 'detect'; bitmap: ImageBitmap };
/** A reply ends the request; a stage message ({ stage }) only reports progress of init. */
export type LandmarkerReply =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; stage: LandmarkerStage };

/** The worker global scope (the project is typed with the DOM lib, not the webworker one). */
const scope = self as unknown as {
  postMessage(m: LandmarkerReply): void;
  onmessage: ((ev: MessageEvent<LandmarkerRequest>) => void) | null;
};
let ready: Promise<FaceLandmarker> | null = null;

function init(base: string, onStage: (s: LandmarkerStage) => void): Promise<FaceLandmarker> {
  if (!ready) {
    ready = createLandmarker(base, onStage).then((lm) => {
      // Warm-up on a blank frame here, off the main thread: the GPU graph is built now and the
      // first real photo is measured without the long wait
      try {
        lm.detect(new ImageData(64, 64));
      } catch {
        /* a blank frame may be rejected; the graph is built by then */
      }
      return lm;
    });
    ready.catch(() => (ready = null));
  }
  return ready;
}

const reply = (m: LandmarkerReply) => scope.postMessage(m);

scope.onmessage = async (ev: MessageEvent<LandmarkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      await init(msg.base, (stage) => reply({ id: msg.id, stage }));
      reply({ id: msg.id, ok: true });
    } else {
      if (!ready) throw new Error('Face Landmarker is not initialised');
      const lm = await ready;
      try {
        const r = lm.detect(msg.bitmap);
        // Plain data only: the result object can hold references MediaPipe reuses on the next call
        reply({
          id: msg.id,
          ok: true,
          result: {
            faceLandmarks: r.faceLandmarks.map((f) => f.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))),
            faceBlendshapes: r.faceBlendshapes.map((c) => ({
              headIndex: c.headIndex,
              headName: c.headName,
              categories: c.categories.map((k) => ({ index: k.index, score: k.score, categoryName: k.categoryName, displayName: k.displayName })),
            })),
            facialTransformationMatrixes: r.facialTransformationMatrixes.map((m) => ({ rows: m.rows, columns: m.columns, data: Array.from(m.data) })),
          },
        });
      } finally {
        msg.bitmap.close();
      }
    }
  } catch (e) {
    reply({ id: msg.id, ok: false, error: (e as Error)?.message ?? String(e) });
  }
};
