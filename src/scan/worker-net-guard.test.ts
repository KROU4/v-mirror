import { describe, expect, it, vi } from 'vitest';
import { allowedSocketUrl, allowedUrl, installNetGuard } from './worker-net-guard';
import { isMediapipeChatter } from './landmarker.quiet';
import visionBundle from '../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs?raw';
import wasmLoader from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js?raw';

const loc = { href: 'https://krou4.github.io/v-mirror/assets/landmarker.worker-abc.js', origin: 'https://krou4.github.io' };

describe('network guard of the detector worker', () => {
  it('allows the site itself, blob: and data:, blocks other hosts', () => {
    expect(allowedUrl('/v-mirror/mediapipe/face_landmarker.task', loc)).toBe(true);
    expect(allowedUrl('../mediapipe/vision_wasm_internal.wasm', loc)).toBe(true);
    expect(allowedUrl('blob:https://krou4.github.io/1234', loc)).toBe(true);
    expect(allowedUrl('data:application/octet-stream;base64,AA==', loc)).toBe(true);
    expect(allowedUrl('https://odml.pa.googleapis.com/v1/log', loc)).toBe(false);
    expect(allowedUrl('https://krou4.github.io.evil.example/x', loc)).toBe(false);
    expect(allowedUrl('http://krou4.github.io/v-mirror/', loc)).toBe(false);
  });

  it('rejects fetch to another origin and passes same-origin requests through', async () => {
    const real = vi.fn(async () => new Response('ok'));
    const scope: { location: typeof loc; fetch?: typeof fetch } = { location: loc, fetch: real as unknown as typeof fetch };
    installNetGuard(scope);
    await expect(scope.fetch!('https://odml.pa.googleapis.com/v1/log', { method: 'POST' })).rejects.toBeInstanceOf(TypeError);
    await expect(scope.fetch!(new Request('https://odml.pa.googleapis.com/v1/log'))).rejects.toBeInstanceOf(TypeError);
    expect(real).not.toHaveBeenCalled();
    await scope.fetch!('/v-mirror/mediapipe/face_landmarker.task');
    expect(real).toHaveBeenCalledTimes(1);
  });

  it('throws on XMLHttpRequest.open to another origin', () => {
    const open = vi.fn();
    class FakeXhr {
      open(...a: unknown[]) {
        open(...a);
      }
    }
    const scope = { location: loc, XMLHttpRequest: FakeXhr as unknown as { prototype: XMLHttpRequest } };
    installNetGuard(scope);
    const x = new FakeXhr();
    expect(() => x.open('POST', 'https://odml.pa.googleapis.com/v1/log')).toThrow(TypeError);
    x.open('GET', '/v-mirror/mediapipe/x.wasm');
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('network guard: sockets, event streams, importScripts', () => {
  class FakeSocket {
    url: string;
    constructor(url: string | URL) {
      this.url = String(url);
    }
  }

  it('WebSocket only to the site itself (wss on https)', () => {
    const scope: { location: typeof loc; WebSocket?: new (u: string) => object } = { location: loc, WebSocket: FakeSocket };
    installNetGuard(scope);
    expect(() => new scope.WebSocket!('wss://odml.pa.googleapis.com/log')).toThrow(TypeError);
    expect(() => new scope.WebSocket!('ws://krou4.github.io/x')).toThrow(TypeError);
    const ok = new scope.WebSocket!('wss://krou4.github.io/x') as FakeSocket;
    expect(ok).toBeInstanceOf(FakeSocket);
    expect(ok.url).toBe('wss://krou4.github.io/x');
    expect(allowedSocketUrl('/v-mirror/live', loc)).toBe(true);
  });

  it('EventSource and importScripts to another origin are blocked', () => {
    const imported: string[] = [];
    const scope: { location: typeof loc; EventSource?: new (u: string) => object; importScripts?: (...u: (string | URL)[]) => void } = {
      location: loc,
      EventSource: FakeSocket,
      importScripts: (...u: (string | URL)[]) => void imported.push(...u.map(String)),
    };
    installNetGuard(scope);
    expect(() => new scope.EventSource!('https://example.org/stream')).toThrow(TypeError);
    expect(new scope.EventSource!('/v-mirror/stream')).toBeInstanceOf(FakeSocket);
    expect(() => scope.importScripts!('/v-mirror/a.js', 'https://cdn.example.org/b.js')).toThrow(TypeError);
    expect(imported).toEqual([]);
    scope.importScripts!('blob:https://krou4.github.io/1');
    expect(imported).toEqual(['blob:https://krou4.github.io/1']);
  });

  // The code that runs in the worker: the MediaPipe bundle and its wasm loader. The guard
  // covers fetch, XMLHttpRequest, WebSocket, EventSource and importScripts; a transport it
  // cannot wrap (sendBeacon, nested workers, WebTransport, RTC) after an update must fail here
  it('MediaPipe uses no network transport the guard does not cover', () => {
    const files = { 'vision_bundle.mjs': visionBundle, 'vision_wasm_module_internal.js': wasmLoader };
    for (const [f, src] of Object.entries(files)) {
      expect(src.length, f).toBeGreaterThan(100_000);
      for (const api of ['sendBeacon', 'WebTransport', 'RTCPeerConnection', 'SharedWorker', 'new Worker(']) expect(src.includes(api), `${f}: ${api}`).toBe(false);
    }
  });
});

describe('MediaPipe console chatter', () => {
  it('filters service lines and keeps real messages', () => {
    expect(isMediapipeChatter('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')).toBe(true);
    expect(isMediapipeChatter('Graph successfully started running.')).toBe(true);
    expect(isMediapipeChatter('W1110 12:00:01.123456  42 gl_context.cc:359] GL version: 3.0')).toBe(true);
    expect(isMediapipeChatter('Failed to load model')).toBe(false);
    expect(isMediapipeChatter({ msg: 'INFO: x' })).toBe(false);
  });
});
