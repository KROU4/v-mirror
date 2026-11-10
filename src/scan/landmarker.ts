// MediaPipe Face Landmarker (runs entirely in the browser, free of charge).
// The detector lives in a Web Worker (landmarker.worker.ts): loading the model, compiling the
// wasm and building the GPU graph took about 2 s of the main thread, during which the scan
// panel did not respond. Without module workers or OffscreenCanvas, or when the worker cannot
// start (blocked module, missing chunk), it runs on the main thread as before.
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { LandmarkerReply, LandmarkerRequest } from './landmarker.worker';

export { isMediapipeChatter } from './landmarker.quiet';

type Source = HTMLCanvasElement | HTMLImageElement | ImageBitmap;
interface Backend {
  detect(source: Source): Promise<FaceLandmarkerResult>;
  dispose(): void;
}

/**
 * Time limits of the worker. load — downloading the loader, the wasm and the model (≈ 14 MB):
 * generous, a slow network is not a failure. build — from the end of the download to a ready
 * detector (GPU graph and the warm-up frame): a graph that hangs is caught in seconds, not after
 * a minute of "looking for a face". detect — measuring one photo.
 */
export const LANDMARKER_TIMEOUT_MS = { load: 180_000, build: 20_000, detect: 20_000 };

let instance: Promise<Backend> | null = null;

/**
 * BASE_URL as an absolute URL. Inside the worker self.location is the worker script
 * (/assets/landmarker.worker-*.js), so a relative base ('./' in a relative build) would point
 * the wasm and the model into /assets/; resolved here against the document it stays right.
 */
export function absoluteBase(base: string = import.meta.env.BASE_URL): string {
  const doc = typeof document !== 'undefined' ? document.baseURI : typeof location !== 'undefined' ? location.href : 'http://localhost/';
  return new URL(base, doc).href;
}

function workerBackend(base: string, forget: () => void): Promise<Backend> {
  return new Promise<Backend>((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./landmarker.worker.ts', import.meta.url), { type: 'module', name: 'face-landmarker' });
    } catch (e) {
      return reject(e);
    }
    let seq = 0;
    let dead: Error | null = null;
    let resolved = false;
    const pending = new Map<number, { ok: (r: unknown) => void; fail: (e: Error) => void; stage: () => void }>();
    const failAll = (e: Error) => {
      for (const p of pending.values()) p.fail(e);
      pending.clear();
    };
    /** The worker is gone (crashed, hung or disposed): every waiting call fails, the next scan starts over. */
    const kill = (e: Error) => {
      if (dead) return;
      dead = e;
      failAll(e);
      w.terminate();
      if (resolved) forget();
      else reject(e);
    };
    /** timeoutMs — until the answer; afterStageMs — re-armed when the worker reports a stage. */
    const call = (m: LandmarkerRequest, timeoutMs: number, transfer: Transferable[] = [], afterStageMs?: number) =>
      new Promise<unknown>((ok, fail) => {
        if (dead) return fail(dead);
        // A hung worker (lost GPU context in OffscreenCanvas, stuck MediaPipe graph) never
        // answers and never fails: without the timer the scan panel would wait forever
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = (ms: number) => {
          clearTimeout(timer);
          timer = setTimeout(() => kill(new Error('Face Landmarker did not respond')), ms);
        };
        arm(timeoutMs);
        pending.set(m.id, {
          ok: (r) => (clearTimeout(timer), ok(r)),
          fail: (e) => (clearTimeout(timer), fail(e)),
          stage: () => afterStageMs !== undefined && arm(afterStageMs),
        });
        w.postMessage(m, transfer);
      });
    w.onmessage = (ev: MessageEvent<LandmarkerReply>) => {
      const r = ev.data;
      const p = pending.get(r.id);
      if (!p) return;
      if ('stage' in r) return p.stage();
      pending.delete(r.id);
      if (r.ok) p.ok(r.result);
      else p.fail(new Error(r.error));
    };
    // A worker that failed to load (old browser, blocked module, 404 chunk) or crashed. During
    // init the rejection lets getLandmarker fall back to the main thread; after init only the
    // backend this worker served is forgotten, so the next call starts a fresh one
    w.onerror = (ev) => {
      ev.preventDefault();
      kill(new Error(ev.message || 'Face Landmarker worker failed'));
    };
    // The download may be slow; once the files are in (stage 'loaded') the graph gets a short
    // limit. A worker that dies after the download falls back to the main thread, which takes
    // the same files from the HTTP cache
    call({ id: ++seq, type: 'init', base }, LANDMARKER_TIMEOUT_MS.load, [], LANDMARKER_TIMEOUT_MS.build)
      .then(() => {
        if (dead) return;
        resolved = true;
        resolve({
          async detect(source) {
            // A copy of the pixels goes to the worker; the caller keeps its own canvas or bitmap
            const bitmap = await createImageBitmap(source);
            return (await call({ id: ++seq, type: 'detect', bitmap }, LANDMARKER_TIMEOUT_MS.detect, [bitmap])) as FaceLandmarkerResult;
          },
          dispose: () => kill(new Error('Face Landmarker was closed')),
        });
      })
      .catch((e: Error) => kill(e));
  });
}

async function mainThreadBackend(base: string): Promise<Backend> {
  const { createLandmarker } = await import('./landmarker.core');
  const lm = await createLandmarker(base);
  return { detect: async (source) => lm.detect(source), dispose: () => lm.close() };
}

let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function backend(): Promise<Backend> {
  clearTimeout(releaseTimer);
  if (instance) return instance;
  const base = absoluteBase();
  const useWorker = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
  const mine: Promise<Backend> = (useWorker ? workerBackend(base, () => instance === mine && (instance = null)) : Promise.reject(new Error('no worker'))).catch(() =>
    mainThreadBackend(base),
  );
  instance = mine;
  mine.catch(() => instance === mine && (instance = null));
  return mine;
}

/** Starts the detector (model, wasm, GPU graph); resolves when it can measure a photo. */
export function getLandmarker(): Promise<void> {
  return backend().then(() => undefined);
}

export async function detect(source: Source): Promise<FaceLandmarkerResult> {
  // The backend promise itself, not the module-level slot: a worker that dies during init
  // clears the slot before the main-thread fallback takes over
  const b = await backend();
  return b.detect(source);
}

/**
 * Frees the detector: the worker (≈ 15 MB of wasm, the model and an extra WebGL context) or the
 * main-thread graph. The scan is usually run once per visit; the next one starts it again.
 */
export function disposeLandmarker() {
  const p = instance;
  instance = null;
  p?.then((b) => b.dispose()).catch(() => {});
}

/** Frees the detector after a pause (the scan panel closed; reopening it soon keeps the warm one). */
export function releaseLandmarkerSoon(ms = 45_000) {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(disposeLandmarker, ms);
}
