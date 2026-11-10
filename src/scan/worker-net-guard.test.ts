import { describe, expect, it, vi } from 'vitest';
import { allowedUrl, installNetGuard } from './worker-net-guard';
import { isMediapipeChatter } from './landmarker.quiet';

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

describe('MediaPipe console chatter', () => {
  it('filters service lines and keeps real messages', () => {
    expect(isMediapipeChatter('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')).toBe(true);
    expect(isMediapipeChatter('Graph successfully started running.')).toBe(true);
    expect(isMediapipeChatter('W1110 12:00:01.123456  42 gl_context.cc:359] GL version: 3.0')).toBe(true);
    expect(isMediapipeChatter('Failed to load model')).toBe(false);
    expect(isMediapipeChatter({ msg: 'INFO: x' })).toBe(false);
  });
});
