// Network guard of the detector worker. The page CSP is a meta tag, and a same-origin module
// worker takes its policy only from its own response headers (GitHub Pages and vite preview send
// none), so inside the worker nothing would stop the MediaPipe usage logger
// (POST https://odml.pa.googleapis.com/v1/log every minute). The guard keeps the worker to the
// same rule as the page: the site itself, blob: and data: only. The logger fails quietly (it
// catches the rejected fetch), while the loader, the wasm and the model keep loading.
// Covered: fetch, XMLHttpRequest, WebSocket, EventSource and importScripts. A dynamic import()
// cannot be wrapped; the only one in the worker is the wasm loader from the site itself
// (landmarker.core.ts), and worker-net-guard.test.ts fails if MediaPipe starts using another
// transport.
// Must be the first import of the worker: imports are hoisted, so it cannot be inline code.

type Ctor = new (...a: never[]) => object;

type GuardScope = {
  location: { href: string; origin: string };
  fetch?: typeof fetch;
  XMLHttpRequest?: { prototype: XMLHttpRequest };
  WebSocket?: Ctor;
  EventSource?: Ctor;
  importScripts?: (...urls: (string | URL)[]) => void;
};

/** Same origin as the worker, or a local blob:/data: URL. */
export function allowedUrl(url: string | URL, base: { href: string; origin: string }): boolean {
  let u: URL;
  try {
    u = new URL(String(url), base.href);
  } catch {
    return false;
  }
  return u.protocol === 'blob:' || u.protocol === 'data:' || u.origin === base.origin;
}

/**
 * WebSocket URLs: ws:/wss: to the site's own host count as the site (the page CSP 'self' allows
 * them the same way); everything else goes through allowedUrl.
 */
export function allowedSocketUrl(url: string | URL, base: { href: string; origin: string }): boolean {
  let u: URL;
  try {
    u = new URL(String(url), base.href);
  } catch {
    return false;
  }
  if (u.protocol === 'ws:' || u.protocol === 'wss:') {
    const own = new URL(base.origin);
    return u.host === own.host && (u.protocol === 'wss:') === (own.protocol === 'https:');
  }
  return allowedUrl(u, base);
}

const blocked = (url: string) => new TypeError(`Blocked by the network guard: ${url}`);

/** A subclass that checks the first argument (the URL) before the real constructor runs. */
function guardCtor<C extends Ctor>(Orig: C, ok: (url: string | URL) => boolean): C {
  const G = class extends (Orig as unknown as new (...a: unknown[]) => object) {
    constructor(...args: unknown[]) {
      const url = args[0] as string | URL;
      if (!ok(url)) throw blocked(String(url));
      super(...args);
    }
  };
  return G as unknown as C;
}

export function installNetGuard(scope: GuardScope): void {
  const loc = scope.location;
  const origFetch = scope.fetch;
  if (origFetch) {
    const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (!allowedUrl(url, loc)) return Promise.reject(blocked(url));
      return origFetch.call(scope, input, init);
    };
    scope.fetch = guarded as typeof fetch;
  }
  const xhr = scope.XMLHttpRequest?.prototype;
  if (xhr) {
    const origOpen = xhr.open as (this: XMLHttpRequest, ...a: unknown[]) => void;
    xhr.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      const url = args[1] as string | URL;
      if (!allowedUrl(url, loc)) throw blocked(String(url));
      return origOpen.apply(this, args);
    } as XMLHttpRequest['open'];
  }
  if (scope.WebSocket) scope.WebSocket = guardCtor(scope.WebSocket, (u) => allowedSocketUrl(u, loc));
  if (scope.EventSource) scope.EventSource = guardCtor(scope.EventSource, (u) => allowedUrl(u, loc));
  const origImport = scope.importScripts;
  if (origImport) {
    scope.importScripts = (...urls: (string | URL)[]) => {
      const bad = urls.find((u) => !allowedUrl(u, loc));
      if (bad !== undefined) throw blocked(String(bad));
      return origImport.apply(scope, urls);
    };
  }
}

// Only inside a worker (tests import the module on a window-like global)
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') installNetGuard(self as unknown as GuardScope);
