import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mainDetect = vi.fn(async () => ({ faceLandmarks: [['main']] }));
const mainClose = vi.fn();
const created: string[] = [];
vi.mock('./landmarker.core', () => ({
  createLandmarker: async (base: string) => {
    created.push(base);
    return { detect: mainDetect, close: mainClose };
  },
}));

type Handler = ((ev: unknown) => void) | null;
let workers: FakeWorker[] = [];
let mode: 'fail-on-start' | 'answer' | 'hang' | 'loaded-then-hang' | 'slow-download' | 'clone-error' = 'answer';
/** Delay of the init answer in 'slow-download', ms. */
let downloadMs = 0;

class FakeWorker {
  onmessage: Handler = null;
  onerror: Handler = null;
  terminated = false;
  posted: { id: number; type: string; base?: string }[] = [];
  constructor() {
    workers.push(this);
    // The script did not load (404, CSP): the error event comes right after construction
    if (mode === 'fail-on-start') queueMicrotask(() => this.onerror?.({ message: 'load failed', preventDefault() {} }));
  }
  postMessage(m: { id: number; type: string; base?: string }) {
    // a detached or closed ImageBitmap cannot be cloned: postMessage throws, nothing is sent
    if (m.type === 'detect' && mode === 'clone-error') throw new DOMException('ImageBitmap is detached', 'DataCloneError');
    this.posted.push(m);
    if (this.terminated) return;
    if (m.type === 'init' && mode === 'loaded-then-hang') {
      queueMicrotask(() => this.onmessage?.({ data: { id: m.id, stage: 'loaded' } }));
      return;
    }
    if (m.type === 'init' && mode === 'slow-download') {
      setTimeout(() => {
        if (this.terminated) return;
        this.onmessage?.({ data: { id: m.id, stage: 'loaded' } });
        this.onmessage?.({ data: { id: m.id, ok: true } });
      }, downloadMs);
      return;
    }
    if (mode !== 'answer' && mode !== 'slow-download') return;
    const result = m.type === 'detect' ? { faceLandmarks: [['worker']] } : undefined;
    queueMicrotask(() => this.onmessage?.({ data: { id: m.id, ok: true, result } }));
  }
  terminate() {
    this.terminated = true;
  }
}

async function fresh() {
  vi.resetModules();
  return import('./landmarker');
}

beforeEach(() => {
  workers = [];
  created.length = 0;
  mainDetect.mockClear();
  mainClose.mockClear();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('landmarker backends', () => {
  it('falls back to the main thread when the worker fails to start', async () => {
    mode = 'fail-on-start';
    const lm = await fresh();
    const r = await lm.detect({} as ImageBitmap);
    expect(r).toEqual({ faceLandmarks: [['main']] });
    expect(mainDetect).toHaveBeenCalledTimes(1);
    expect(workers[0].terminated).toBe(true);
    // the next detect reuses the fallback instead of building a new broken worker
    await lm.detect({} as ImageBitmap);
    expect(workers).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it('uses the worker when it starts, with an absolute base URL', async () => {
    mode = 'answer';
    const lm = await fresh();
    const r = await lm.detect({} as ImageBitmap);
    expect(r).toEqual({ faceLandmarks: [['worker']] });
    expect(mainDetect).not.toHaveBeenCalled();
    expect(workers[0].posted[0].type).toBe('init');
    expect(workers[0].posted[0].base).toMatch(/^[a-z]+:\/\//);
  });

  it('absoluteBase resolves a relative build base against the page, not the worker script', async () => {
    const lm = await fresh();
    vi.stubGlobal('document', { baseURI: 'https://example.org/v-mirror/index.html' });
    expect(lm.absoluteBase('./')).toBe('https://example.org/v-mirror/');
    expect(lm.absoluteBase('/v-mirror/')).toBe('https://example.org/v-mirror/');
  });

  it('a hung worker times out, is terminated and the next call starts over', async () => {
    vi.useFakeTimers();
    mode = 'answer';
    const lm = await fresh();
    await lm.getLandmarker();
    mode = 'hang';
    const p = lm.detect({} as ImageBitmap);
    const failed = expect(p).rejects.toThrow(/did not respond/);
    await vi.advanceTimersByTimeAsync(lm.LANDMARKER_TIMEOUT_MS.detect + 10);
    await failed;
    expect(workers[0].terminated).toBe(true);
    mode = 'answer';
    await expect(lm.detect({} as ImageBitmap)).resolves.toEqual({ faceLandmarks: [['worker']] });
    expect(workers).toHaveLength(2);
  });

  it('a worker that never finishes init falls back to the main thread', async () => {
    vi.useFakeTimers();
    mode = 'hang';
    const lm = await fresh();
    const p = lm.detect({} as ImageBitmap);
    await vi.advanceTimersByTimeAsync(lm.LANDMARKER_TIMEOUT_MS.load + 10);
    await expect(p).resolves.toEqual({ faceLandmarks: [['main']] });
    expect(workers[0].terminated).toBe(true);
  });

  it('a slow download is not a failure: the worker gets the whole load limit', async () => {
    vi.useFakeTimers();
    mode = 'slow-download';
    const lm = await fresh();
    // longer than the graph limit, well inside the download one
    downloadMs = lm.LANDMARKER_TIMEOUT_MS.build * 3;
    const p = lm.detect({} as ImageBitmap);
    await vi.advanceTimersByTimeAsync(downloadMs + 10);
    await expect(p).resolves.toEqual({ faceLandmarks: [['worker']] });
    expect(workers[0].terminated).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('a graph that hangs after the download is caught by the short build limit', async () => {
    vi.useFakeTimers();
    mode = 'loaded-then-hang';
    const lm = await fresh();
    let settled = false;
    const p = lm.detect({} as ImageBitmap).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(lm.LANDMARKER_TIMEOUT_MS.build - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({ faceLandmarks: [['main']] });
    expect(workers[0].terminated).toBe(true);
    expect(lm.LANDMARKER_TIMEOUT_MS.build).toBeLessThan(lm.LANDMARKER_TIMEOUT_MS.load / 4);
  });

  it('worker errors carry a code for the UI text', async () => {
    vi.useFakeTimers();
    mode = 'answer';
    const lm = await fresh();
    await lm.getLandmarker();
    mode = 'hang';
    const p = lm.detect({} as ImageBitmap).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(lm.LANDMARKER_TIMEOUT_MS.detect + 10);
    const e = await p;
    expect(e).toBeInstanceOf(lm.LandmarkerError);
    expect(lm.landmarkerErrorCode(e)).toBe('timeout');
    // a reply with a code from the worker is rebuilt as the same coded error
    expect(lm.landmarkerErrorCode({ name: 'LandmarkerError', code: 'download' })).toBe('download');
    expect(lm.landmarkerErrorCode({ name: 'LandmarkerError', code: 'nope' })).toBeNull();
    expect(lm.landmarkerErrorCode(new Error('x'))).toBeNull();
  });

  it('the photo bitmap is closed when the worker died before it was sent', async () => {
    mode = 'answer';
    const lm = await fresh();
    await lm.getLandmarker();
    const close = vi.fn();
    // the worker crashes while the copy of the photo is being made
    vi.stubGlobal('createImageBitmap', async () => {
      workers[0].onerror?.({ message: 'crashed', preventDefault() {} });
      return { close };
    });
    const e = await lm.detect({} as ImageBitmap).catch((x: unknown) => x);
    expect(lm.landmarkerErrorCode(e)).toBe('crashed');
    expect(close).toHaveBeenCalledTimes(1);
    expect(workers[0].posted.filter((m) => m.type === 'detect')).toHaveLength(0);
  });

  it('a bitmap handed to the worker is not closed on the main thread', async () => {
    mode = 'answer';
    const lm = await fresh();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', async () => ({ close }));
    await lm.detect({} as ImageBitmap);
    expect(close).not.toHaveBeenCalled();
  });

  it('postMessage that throws fails only that call: no timeout later, the worker stays', async () => {
    vi.useFakeTimers();
    mode = 'answer';
    const lm = await fresh();
    await lm.getLandmarker();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', async () => ({ close }));
    mode = 'clone-error';
    const e = await lm.detect({} as ImageBitmap).catch((x: unknown) => x);
    expect((e as Error).name).toBe('DataCloneError');
    // the copy never reached the worker: it is closed here
    expect(close).toHaveBeenCalledTimes(1);
    // the timer of the failed call is gone: the healthy worker is not killed after the limit
    await vi.advanceTimersByTimeAsync(lm.LANDMARKER_TIMEOUT_MS.detect + 10);
    expect(workers[0].terminated).toBe(false);
    mode = 'answer';
    await expect(lm.detect({} as ImageBitmap)).resolves.toEqual({ faceLandmarks: [['worker']] });
    expect(workers).toHaveLength(1);
  });

  it('disposeLandmarker terminates the worker; the next scan builds a new one', async () => {
    mode = 'answer';
    const lm = await fresh();
    await lm.getLandmarker();
    lm.disposeLandmarker();
    await Promise.resolve();
    await Promise.resolve();
    expect(workers[0].terminated).toBe(true);
    await lm.detect({} as ImageBitmap);
    expect(workers).toHaveLength(2);
  });
});
