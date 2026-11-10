// Network guard of the detector worker. The page CSP is a meta tag, and a same-origin module
// worker takes its policy only from its own response headers (GitHub Pages and vite preview send
// none), so inside the worker nothing would stop the MediaPipe usage logger
// (POST https://odml.pa.googleapis.com/v1/log every minute). The guard keeps the worker to the
// same rule as the page: the site itself, blob: and data: only. The logger fails quietly (it
// catches the rejected fetch), while the loader, the wasm and the model keep loading.
// Must be the first import of the worker: imports are hoisted, so it cannot be inline code.

type GuardScope = {
  location: { href: string; origin: string };
  fetch?: typeof fetch;
  XMLHttpRequest?: { prototype: XMLHttpRequest };
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

const blocked = (url: string) => new TypeError(`Blocked by the network guard: ${url}`);

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
}

// Only inside a worker (tests import the module on a window-like global)
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') installNetGuard(self as unknown as GuardScope);
