// Creating MediaPipe Face Landmarker. Shared by the Web Worker (the normal path) and the
// main-thread fallback, so both build the detector the same way.
import { FaceLandmarker } from '@mediapipe/tasks-vision';

import { LandmarkerError } from './landmarker.errors';
import { quietMediapipe } from './landmarker.quiet';

type WasmFileset = Parameters<typeof FaceLandmarker.createFromOptions>[0];

/** Files copied by tools/setup-assets.mjs into public/mediapipe. */
export const WASM_LOADER = 'mediapipe/wasm/vision_wasm_module_internal.js';
export const WASM_BINARY = 'mediapipe/wasm/vision_wasm_module_internal.wasm';
export const MODEL = 'mediapipe/face_landmarker.task';

type Factory = (m?: unknown) => Promise<unknown>;
const g = globalThis as unknown as { ModuleFactory?: Factory };

/** Stages of the start: 'loaded' — the loader, the wasm and the model are downloaded. */
export type LandmarkerStage = 'loaded';

async function bytes(url: string): Promise<ArrayBuffer> {
  // A network failure (offline, blocked) is a failed download too, not an unknown error
  const r = await fetch(url).catch((e: unknown) => {
    throw new LandmarkerError('download', `${url}: ${(e as Error)?.message ?? String(e)}`);
  });
  if (!r.ok) throw new LandmarkerError('download', `${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/**
 * The ES-module build of the wasm loader works the same in a module worker and on the main
 * thread (the classic loader needs importScripts or a <script> tag). It is imported here and
 * handed to MediaPipe through globalThis.ModuleFactory, which MediaPipe clears after each use.
 *
 * The download (≈ 14 MB of wasm and model) and the graph build are separate steps: onStage
 * reports the end of the download, so the caller can give a slow network its time and still
 * catch a GPU graph that hangs. The wasm goes to MediaPipe as a blob URL and the model as a
 * buffer: nothing is downloaded twice.
 */
export async function createLandmarker(base: string, onStage?: (s: LandmarkerStage) => void): Promise<FaceLandmarker> {
  quietMediapipe();
  // base is absolute (absoluteBase on the main thread): inside the worker self.location is
  // the worker script, and a relative base would resolve against /assets/
  const abs = (p: string) => new URL(p, base).href;
  const [mod, wasm, model] = await Promise.all([
    import(/* @vite-ignore */ abs(WASM_LOADER)) as Promise<{ default?: Factory }>,
    bytes(abs(WASM_BINARY)),
    bytes(abs(MODEL)),
  ]);
  const factory = mod.default ?? g.ModuleFactory;
  if (!factory) throw new LandmarkerError('loader', 'MediaPipe wasm loader did not load');
  onStage?.('loaded');
  const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
  // An empty loader path tells MediaPipe the factory is already in place
  const fileset: WasmFileset = { wasmLoaderPath: '', wasmBinaryPath: wasmUrl };
  const create = (delegate: 'GPU' | 'CPU') => {
    g.ModuleFactory = factory;
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  };
  try {
    return await create('GPU');
  } catch {
    return await create('CPU');
  } finally {
    URL.revokeObjectURL(wasmUrl);
  }
}
