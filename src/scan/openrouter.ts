// OpenRouter from the browser only: the user's own key lives in localStorage of this
// browser and is sent to openrouter.ai and nowhere else. The site has no server.
import { useSyncExternalStore } from 'react';

export const OPENROUTER = 'https://openrouter.ai/api/v1';
export const KEYS_URL = 'https://openrouter.ai/keys';

/** Free vision models to start with, best first (the list is refreshed from OpenRouter). */
export const DEFAULT_MODELS = ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3.5-super-vl:free'];

export type OpenRouterErrorCode =
  | 'unauthorized'
  | 'payment'
  | 'forbidden'
  | 'rate'
  | 'model'
  | 'timeout'
  | 'network'
  | 'http'
  | 'badJson'
  | 'empty';

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  readonly status?: number;
  readonly detail?: string;
  constructor(code: OpenRouterErrorCode, opts: { status?: number; detail?: string } = {}) {
    super(`openrouter:${code}${opts.status ? ` ${opts.status}` : ''}${opts.detail ? ` ${opts.detail}` : ''}`);
    this.name = 'OpenRouterError';
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

/** HTTP status of a failed OpenRouter call → error code. */
export function codeOfStatus(status: number): OpenRouterErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'payment';
  if (status === 403) return 'forbidden';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 429) return 'rate';
  if (status === 404 || status === 400) return 'model';
  return 'http';
}

async function errorOf(r: Response): Promise<OpenRouterError> {
  const body = await r.text().catch(() => '');
  let detail = body.slice(0, 240);
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail;
  } catch {
    /* not JSON */
  }
  return new OpenRouterError(codeOfStatus(r.status), { status: r.status, detail: detail.trim() || r.statusText });
}

/** fetch that turns a dropped connection into OpenRouterError('network'); aborts pass through. */
async function call(url: string, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new OpenRouterError('network', { detail: (e as Error)?.message });
  }
}

// ------------------------------------------------------------------ models
export interface ModelInfo {
  id: string;
  name: string;
  free: boolean;
  pricePrompt: number;
}

interface RawModel {
  id: string;
  name: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt: string; completion: string };
}

/** Image-in, text-out models; free ones first, then by price. */
export function visionModels(data: RawModel[]): ModelInfo[] {
  return data
    .filter((m) => m.architecture?.input_modalities?.includes('image') && (m.architecture?.output_modalities ?? ['text']).includes('text'))
    .filter((m) => m.id !== 'openrouter/free' && m.id !== 'openrouter/auto')
    .map((m) => ({
      id: m.id,
      name: m.name,
      free: Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0,
      pricePrompt: Number(m.pricing?.prompt ?? 0),
    }))
    .sort((x, y) => Number(y.free) - Number(x.free) || x.pricePrompt - y.pricePrompt || x.name.localeCompare(y.name));
}

export async function listVisionModels(fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const r = await call(`${OPENROUTER}/models`, {}, fetchImpl);
  if (!r.ok) throw await errorOf(r);
  const j = (await r.json()) as { data?: RawModel[] };
  return visionModels(j.data ?? []);
}

/** The model to use when the user has not picked one: a preferred free model, else the first free one. */
export function defaultModel(models: ModelInfo[] | null): string {
  if (models?.length) {
    for (const id of DEFAULT_MODELS) if (models.some((m) => m.id === id)) return id;
    const free = models.find((m) => m.free);
    if (free) return free.id;
  }
  return DEFAULT_MODELS[0];
}

// ------------------------------------------------------------------ key check
export interface KeyInfo {
  label?: string;
  freeTier: boolean;
  /** remaining spend limit in USD; null = unlimited */
  limitRemaining: number | null;
  usage?: number;
}

/** GET /key: validates the key and reports its limits. */
export async function checkKey(key: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<KeyInfo> {
  const r = await call(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${key}` }, signal }, fetchImpl);
  if (!r.ok) throw await errorOf(r);
  const j = (await r.json().catch(() => null)) as {
    data?: { label?: string; is_free_tier?: boolean; limit_remaining?: number | null; limit?: number | null; usage?: number };
  } | null;
  if (!j?.data) throw new OpenRouterError('badJson');
  const d = j.data;
  return {
    label: typeof d.label === 'string' && !/^sk-or-/.test(d.label) ? d.label : undefined,
    freeTier: !!d.is_free_tier,
    limitRemaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
    usage: d.usage,
  };
}

export const looksLikeKey = (k: string) => /^sk-or-[\w-]{10,}$/.test(k.trim());

// ------------------------------------------------------------------ chat
export async function callOpenRouter(opts: {
  key: string;
  model: string;
  imageDataUrl: string;
  prompt: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const r = await call(
    `${OPENROUTER}/chat/completions`,
    {
      method: 'POST',
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${opts.key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://localhost',
        'X-Title': 'V-MIRROR',
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              { type: 'image_url', image_url: { url: opts.imageDataUrl } },
            ],
          },
        ],
      }),
    },
    opts.fetchImpl,
  );
  if (!r.ok) throw await errorOf(r);
  const body = await r.text();
  let j: { choices?: { message?: { content?: unknown } }[]; error?: { message?: string; code?: number } };
  try {
    j = JSON.parse(body);
  } catch {
    throw new OpenRouterError('badJson');
  }
  // OpenRouter reports provider failures as 200 with an error object
  if (j.error) {
    const status = typeof j.error.code === 'number' ? j.error.code : 502;
    throw new OpenRouterError(codeOfStatus(status), { status, detail: j.error.message });
  }
  const raw = j.choices?.[0]?.message?.content;
  // some providers return content as an array of parts [{type:'text', text}]
  const content = Array.isArray(raw)
    ? raw.map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text ?? '') : '')).join('')
    : typeof raw === 'string'
      ? raw
      : '';
  if (!content.trim()) throw new OpenRouterError('empty');
  return content;
}

// ------------------------------------------------------------------ settings (this browser only)
export type KeyCheck =
  | { s: 'idle' }
  | { s: 'checking' }
  | { s: 'ok'; info: KeyInfo }
  | { s: 'fail'; err: OpenRouterError };

export interface OrSettings {
  key: string;
  /**
   * true — the key stays in this browser (localStorage) between visits; false — only for
   * this tab (sessionStorage), for shared computers
   */
  remember: boolean;
  /** model id; '' = not picked by the user (the default free model is used) */
  model: string;
  check: KeyCheck;
}

const K_KEY = 'vm.orKey';
const K_MODEL = 'vm.orModel';
const K_PICKED = 'vm.orModelPicked';
const K_REMEMBER = 'vm.orRemember';

function storage(kind: 'local' | 'session') {
  const area = () => (kind === 'local' ? localStorage : sessionStorage);
  return {
    get(k: string): string {
      try {
        return area().getItem(k) ?? '';
      } catch {
        return '';
      }
    },
    set(k: string, v: string) {
      try {
        if (v) area().setItem(k, v);
        else area().removeItem(k);
      } catch {
        /* private mode: works without saving */
      }
    },
  };
}
const ls = storage('local');
const ss = storage('session');
/** Where the key lives: localStorage when remembered, else sessionStorage (this tab only). */
const keyStore = (remember: boolean) => (remember ? ls : ss);

/**
 * The site runs on a host shared with other sites (a *.github.io project page): every page
 * of that origin can read localStorage. There the key stays in this tab by default and is
 * remembered only after an explicit opt-in.
 */
export function sharedOrigin(hostname: string): boolean {
  return /\.github\.io$/i.test(hostname);
}
export const SHARED_ORIGIN = typeof location !== 'undefined' && sharedOrigin(location.hostname);

/** Remember the key by default: yes on an own origin (unless turned off), no on a shared one (unless turned on). */
export function rememberDefault(stored: string, shared: boolean): boolean {
  return shared ? stored === '1' : stored !== '0';
}

const remembered = rememberDefault(ls.get(K_REMEMBER), SHARED_ORIGIN);
let settings: OrSettings = {
  key: keyStore(remembered).get(K_KEY),
  remember: remembered,
  // a model saved by older versions counts as picked only when the user picked it
  model: ls.get(K_PICKED) ? ls.get(K_MODEL) : '',
  check: { s: 'idle' },
};
const subs = new Set<() => void>();
const emit = () => subs.forEach((cb) => cb());

export function getOrSettings(): OrSettings {
  return settings;
}
export function subscribeOr(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
export function useOrSettings(): OrSettings {
  return useSyncExternalStore(subscribeOr, getOrSettings, getOrSettings);
}

let checkAbort: AbortController | null = null;

export function setOrKey(key: string) {
  const k = key.trim();
  if (k === settings.key) return;
  checkAbort?.abort();
  keyStore(settings.remember).set(K_KEY, k);
  settings = { ...settings, key: k, check: { s: 'idle' } };
  emit();
}

/**
 * Remember the key on this device or keep it for this tab only. The key moves to the chosen
 * storage and is removed from the other one.
 */
export function setOrRemember(remember: boolean) {
  if (remember === settings.remember) return;
  keyStore(!remember).set(K_KEY, '');
  keyStore(remember).set(K_KEY, settings.key);
  ls.set(K_REMEMBER, remember ? '1' : '0');
  settings = { ...settings, remember };
  emit();
}

export function setOrModel(model: string) {
  ls.set(K_MODEL, model);
  ls.set(K_PICKED, model ? '1' : '');
  settings = { ...settings, model };
  emit();
}

/** Checks the stored key; the result stays until the key changes. */
export async function runKeyCheck(fetchImpl?: typeof fetch): Promise<void> {
  const key = settings.key;
  if (!key) return;
  checkAbort?.abort();
  const ac = new AbortController();
  checkAbort = ac;
  settings = { ...settings, check: { s: 'checking' } };
  emit();
  try {
    const info = await checkKey(key, ac.signal, fetchImpl);
    if (ac.signal.aborted || settings.key !== key) return;
    settings = { ...settings, check: { s: 'ok', info } };
  } catch (e) {
    if (ac.signal.aborted || settings.key !== key) return;
    const err = e instanceof OpenRouterError ? e : new OpenRouterError('network', { detail: (e as Error)?.message });
    settings = { ...settings, check: { s: 'fail', err } };
  }
  emit();
}

// shared model list (fetched once per page)
let modelsP: Promise<ModelInfo[]> | null = null;
export function loadModels(): Promise<ModelInfo[]> {
  if (!modelsP) {
    modelsP = listVisionModels();
    modelsP.catch(() => (modelsP = null));
  }
  return modelsP;
}

/** Tests only. */
export function __resetOrForTests(s?: Partial<OrSettings>) {
  checkAbort?.abort();
  settings = { key: '', model: '', remember: true, check: { s: 'idle' }, ...s };
  modelsP = null;
  subs.clear();
}
