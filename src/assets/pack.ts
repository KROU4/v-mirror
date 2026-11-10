// Asset pack: meshes, textures and manifests that the user generates from their own
// game install (irm <site>/pack.ps1 | iex, or npm run pack) and connects in the browser. Nothing from the game ships
// with the site. In dev, tools/local is served by Vite at /game/... and used directly.
//
// Every load of a game asset goes through gameAssetUrl / fetchGameJson / hasGameAsset.

export type PackSource = { kind: 'dev' } | { kind: 'dir'; name: string };

/** pack.json at the pack root (written by tools/extract/pack.mjs). */
export interface PackManifest {
  format: 1;
  gameVersion?: string;
  createdAt?: string;
  files?: number;
  tool?: string;
}

export interface PackState {
  status: 'none' | 'connecting' | 'ready' | 'error';
  source?: PackSource;
  error?: string;
  /** pack.json of the connected pack (dev may run without one) */
  manifest?: PackManifest;
  /** a folder connected earlier whose read permission must be granted again (restorePack) */
  remembered?: string;
  /**
   * Identity of the connected pack: grows only when a pack becomes ready (a new folder or the
   * dev route). Consumers that build on the pack (the 3D engine, thumbnail caches) key on it,
   * not on the state object, which also changes while another folder is being checked.
   */
  packId?: number;
  /** ready, while another folder is being checked: the current pack keeps working */
  busy?: boolean;
  /** ready, but switching to another folder failed: why (the previous pack stays connected) */
  lastError?: string;
}

export const PACK_FORMAT = 1;
/** File every usable pack must contain besides pack.json. */
const REQUIRED = 'body/manifest.json';

// ------------------------------------------------------------------ minimal File System Access types
// (declared here: lib.dom does not describe permissions, entries() or showDirectoryPicker everywhere)
export interface PackFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}
export interface PackDirHandle {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string): Promise<PackDirHandle>;
  getFileHandle(name: string): Promise<PackFileHandle>;
  values?(): AsyncIterable<PackDirHandle | PackFileHandle>;
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

/** Where the remembered folder handle lives (IndexedDB in the browser). */
export interface HandleStore {
  get(): Promise<PackDirHandle | null>;
  set(h: PackDirHandle | null): Promise<void>;
}

export interface PackEnv {
  /** Vite serves tools/local at /game/ (dev with local assets) */
  devPack: boolean;
  /** URL prefix of the dev route, e.g. '/game/' */
  devBase: string;
  fetch: typeof fetch;
  /** window.showDirectoryPicker, when the browser has it */
  pickDirectory?: () => Promise<PackDirHandle>;
  /** <input webkitdirectory> fallback: files with webkitRelativePath, null when cancelled */
  pickFiles?: () => Promise<File[] | null>;
  store?: HandleStore;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
}

// ------------------------------------------------------------------ readers
interface PackReader {
  name: string;
  file(path: string): Promise<File | null>;
}

const isNotFound = (e: unknown) => {
  const n = (e as { name?: string })?.name;
  return n === 'NotFoundError' || n === 'TypeMismatchError' || n === 'NotFound';
};

function handleReader(root: PackDirHandle, name = root.name): PackReader {
  const dirs = new Map<string, Promise<PackDirHandle | null>>();
  const dir = (parts: string[]): Promise<PackDirHandle | null> => {
    if (!parts.length) return Promise.resolve(root);
    const key = parts.join('/');
    let p = dirs.get(key);
    if (!p) {
      p = dir(parts.slice(0, -1)).then((parent) =>
        parent
          ? parent.getDirectoryHandle(parts[parts.length - 1]).catch((e) => {
              if (isNotFound(e)) return null;
              throw e;
            })
          : null,
      );
      dirs.set(key, p);
    }
    return p;
  };
  return {
    name,
    async file(path) {
      const parts = path.split('/');
      const d = await dir(parts.slice(0, -1));
      if (!d) return null;
      try {
        return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
  };
}

function mapReader(name: string, files: Map<string, File>): PackReader {
  return { name, file: async (path) => files.get(path) ?? null };
}

// ------------------------------------------------------------------ paths
/** 'glb/x.glb' → normalised relative path; throws on traversal and odd segments. */
export function packPath(path: string): string {
  const p = path.replace(/^\/+/, '').replace(/^game\//, '');
  const parts = p.split('/');
  if (!p || p.includes('\\') || p.includes('\0') || parts.some((s) => !s || s === '.' || s === '..'))
    throw new Error(`bad pack path: ${path}`);
  return parts.join('/');
}

// ------------------------------------------------------------------ state
const subs = new Set<(s: PackState) => void>();
let state: PackState = { status: 'none' };
let env: PackEnv | null = null;
let reader: PackReader | null = null;
/** grows when the pack in use changes (a new pack is ready, or disconnect): late results of the old one are dropped */
let gen = 0;
/** grows on every connect/restore attempt: a newer attempt wins over a slower older one */
let attempt = 0;
let packSeq = 0;
let urls = new Map<string, Promise<string>>();
let jsons = new Map<string, Promise<unknown>>();
let rememberedHandle: PackDirHandle | null = null;
let settle: Promise<void> = Promise.resolve();
let started = false;

function set(s: PackState) {
  state = s;
  for (const cb of [...subs]) {
    try {
      cb(state);
    } catch (e) {
      console.error(e);
    }
  }
}

function dropCaches() {
  const old = urls;
  urls = new Map();
  jsons = new Map();
  const e = env;
  if (e)
    for (const p of old.values())
      p.then((u) => {
        if (u.startsWith('blob:')) e.revokeObjectURL(u);
      }).catch(() => {});
}

function getEnv(): PackEnv {
  if (!env) env = browserEnv();
  return env;
}

export function getPackState(): PackState {
  start();
  return state;
}

export function subscribePack(cb: (s: PackState) => void): () => void {
  start();
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Resolves once the current connect/restore attempt has finished. */
export async function whenPackSettled(): Promise<PackState> {
  start();
  let s: Promise<void>;
  do {
    s = settle;
    await s;
  } while (s !== settle);
  return state;
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';
/**
 * Error text with the DOMException name in front (NotReadableError: …): browser messages
 * differ between engines and languages, the name does not — the UI maps it to its own text.
 */
const errText = (e: unknown) => {
  const x = e as { name?: unknown; message?: unknown } | null;
  const msg = typeof x?.message === 'string' ? x.message : String(e);
  const name = typeof x?.name === 'string' && x.name && x.name !== 'Error' ? x.name : '';
  return name && !msg.startsWith(name) ? `${name}: ${msg}` : msg;
};

/**
 * One connect/restore attempt. `choose` runs the folder picker or the permission prompt and
 * changes nothing; only once it has returned a folder is that folder checked (`verify`).
 * While a new folder is checked an already connected pack stays ready (busy) and keeps
 * serving files; if the new folder is not a pack, the old one stays connected (lastError).
 */
type Picked = { handle: PackDirHandle } | { files: File[] };

function attemptConnect(choose: () => Promise<Picked | null>): Promise<void> {
  const p = (async () => {
    let picked: Picked | null;
    try {
      picked = await choose();
    } catch (e) {
      if (!isAbort(e)) fail(e);
      return;
    }
    if (!picked) return; // cancelled: nothing changes
    // from here on this attempt owns the state; an older one still running is dropped
    await verify(++attempt, picked);
  })();
  settle = p;
  return p;
}

function fail(e: unknown) {
  const prev = state;
  if (prev.status === 'ready') set({ ...prev, busy: false, lastError: errText(e) });
  else set({ status: 'error', error: errText(e), remembered: rememberedHandle?.name ?? prev.remembered });
}

async function verify(a: number, picked: Picked) {
  const prev = state;
  set(prev.status === 'ready' ? { ...prev, busy: true, lastError: undefined } : { status: 'connecting', source: prev.source, remembered: prev.remembered });
  const handle = 'handle' in picked ? picked.handle : null;
  let r: PackReader;
  let manifest: PackManifest;
  try {
    r = 'handle' in picked ? await locatePack(picked.handle) : filesReader(picked.files);
    manifest = await readManifest(r);
  } catch (e) {
    if (a === attempt) fail(e);
    return;
  }
  if (a !== attempt) return;
  gen++;
  dropCaches();
  reader = r;
  rememberedHandle = handle;
  set({ status: 'ready', source: { kind: 'dir', name: r.name }, manifest, packId: ++packSeq });
  if (handle) await getEnv().store?.set(handle).catch(() => {});
}

async function readManifest(r: PackReader): Promise<PackManifest> {
  const f = await r.file('pack.json');
  if (!f) throw new Error('This folder is not an asset pack: pack.json is missing');
  let m: PackManifest;
  try {
    m = JSON.parse(stripBom(await f.text())) as PackManifest;
  } catch {
    throw new Error('pack.json is not valid JSON');
  }
  if (!m || typeof m !== 'object' || m.format !== PACK_FORMAT)
    throw new Error(`Unsupported asset pack format ${String((m as { format?: unknown })?.format)} (expected ${PACK_FORMAT}); rebuild the pack (irm <site>/pack.ps1 | iex)`);
  if (!(await r.file(REQUIRED))) throw new Error(`The asset pack is incomplete: ${REQUIRED} is missing`);
  return m;
}

/** The picked folder may be the pack itself or its parent: look one level down. */
async function locatePack(root: PackDirHandle): Promise<PackReader> {
  const direct = handleReader(root);
  if (await direct.file('pack.json')) return direct;
  if (root.values) {
    for await (const h of root.values()) {
      if (h.kind !== 'directory') continue;
      const sub = handleReader(h, `${root.name}/${h.name}`);
      if (await sub.file('pack.json')) return sub;
    }
  }
  return direct;
}

function filesReader(files: File[]): PackReader {
  // webkitRelativePath = '<picked>/<…>/pack.json': re-root at the folder that has pack.json
  const rel = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/');
  const all = files.map((f) => ({ f, p: rel(f) }));
  const manifests = all.filter((x) => x.p === 'pack.json' || x.p.endsWith('/pack.json')).sort((a, b) => a.p.length - b.p.length);
  const prefix = manifests.length ? manifests[0].p.slice(0, -'pack.json'.length) : all[0]?.p.split('/')[0] + '/';
  const map = new Map<string, File>();
  for (const { f, p } of all) if (p.startsWith(prefix)) map.set(p.slice(prefix.length), f);
  return mapReader(prefix.replace(/\/$/, '') || 'pack', map);
}

/**
 * Lets the user pick the asset pack folder (showDirectoryPicker, or an <input webkitdirectory>
 * where the browser has no picker). Must be called from a user gesture. Until the picker
 * returns a folder nothing changes: cancelling it keeps the current pack as it was.
 */
export function connectPackDirectory(): Promise<void> {
  start();
  const e = getEnv();
  return attemptConnect(async () => {
    if (e.pickDirectory) return { handle: await e.pickDirectory() };
    if (!e.pickFiles) throw new Error('This browser cannot open folders');
    const files = await e.pickFiles();
    return files && files.length ? { files } : null;
  });
}

/** Re-opens the remembered folder (asks for read permission; call from a user gesture). */
export function restorePack(): Promise<void> {
  start();
  const h = rememberedHandle;
  if (!h) return connectPackDirectory();
  return attemptConnect(async () => {
    const p = h.requestPermission ? await h.requestPermission({ mode: 'read' }) : 'granted';
    if (p !== 'granted') throw new Error('Read access to the asset pack folder was not granted');
    return { handle: h };
  });
}

/**
 * Forgets the connected folder (also the remembered handle). In dev with local assets the
 * Vite route becomes the source again, as after a page reload.
 */
export function disconnectPack() {
  start();
  attempt++;
  gen++;
  dropCaches();
  reader = null;
  rememberedHandle = null;
  getEnv().store?.set(null).catch(() => {});
  set({ status: 'none' });
  const e = getEnv();
  if (e.devPack) {
    const a = attempt;
    settle = probeDev(e).then((m) => {
      if (a !== attempt || m === false) return;
      gen++;
      set({ status: 'ready', source: { kind: 'dev' }, manifest: m ?? undefined, packId: ++packSeq });
    });
  }
}

/**
 * HEAD request whose (empty) body is read to the end: Chromium logs a HEAD response that is
 * never consumed as net::ERR_ABORTED, which looks like a failed asset in the network log.
 */
async function head(e: PackEnv, url: string): Promise<Response | null> {
  const r = await e.fetch(url, { method: 'HEAD' }).catch(() => null);
  if (r && typeof r.text === 'function') await r.text().catch(() => '');
  return r;
}

async function probeDev(e: PackEnv): Promise<PackManifest | null | false> {
  // HEAD: the body is not needed here (Character reads the manifest itself), and a cancelled
  // GET shows up as an aborted request in the network log
  const r = await head(e, e.devBase + REQUIRED);
  if (!r || !r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return false;
  const m = await e
    .fetch(e.devBase + 'pack.json')
    .then(async (x) => {
      if (x.ok && (x.headers.get('content-type') ?? '').includes('json')) return (await x.json()) as PackManifest;
      // a dev pack may have no pack.json: read the 404 body to the end instead of dropping it
      await x.text().catch(() => '');
      return null;
    })
    .catch(() => null);
  return m;
}

/** Startup: dev assets when Vite serves them, else the folder remembered from last time. */
function start() {
  if (started) return;
  started = true;
  const e = getEnv();
  const a = ++attempt;
  set({ status: 'connecting' });
  settle = (async () => {
    if (e.devPack) {
      const m = await probeDev(e);
      if (a !== attempt) return;
      if (m !== false) {
        gen++;
        set({ status: 'ready', source: { kind: 'dev' }, manifest: m ?? undefined, packId: ++packSeq });
        return;
      }
    }
    const h = await e.store?.get().catch(() => null);
    if (a !== attempt) return;
    if (!h) {
      set({ status: 'none' });
      return;
    }
    rememberedHandle = h;
    const perm = h.queryPermission ? await h.queryPermission({ mode: 'read' }).catch(() => 'prompt' as const) : 'granted';
    if (a !== attempt) return;
    if (perm !== 'granted') {
      set({ status: 'none', remembered: h.name });
      return;
    }
    let r: PackReader;
    let manifest: PackManifest;
    try {
      r = await locatePack(h);
      manifest = await readManifest(r);
    } catch {
      // folder moved or rebuilt: offer to pick it again
      if (a === attempt) set({ status: 'none', remembered: h.name });
      return;
    }
    if (a !== attempt) return;
    gen++;
    reader = r;
    set({ status: 'ready', source: { kind: 'dir', name: r.name }, manifest, packId: ++packSeq });
  })().catch((err: unknown) => {
    if (a === attempt) set({ status: 'none', remembered: rememberedHandle?.name, error: errText(err) });
  });
}

async function ready(): Promise<PackState> {
  if (state.status === 'connecting') await whenPackSettled();
  return state;
}

function notConnected(path: string): Error {
  const err = new Error(`${path}: asset pack is not connected`);
  err.name = 'PackNotConnected';
  return err;
}

// ------------------------------------------------------------------ public loaders
/** URL of a pack file ('glb/x.glb', 'body/manifest.json'): /game/… in dev, a cached blob: URL otherwise. */
export async function gameAssetUrl(path: string): Promise<string> {
  start();
  const rel = packPath(path);
  const s = await ready();
  if (s.status !== 'ready') throw notConnected(rel);
  const e = getEnv();
  if (s.source?.kind === 'dev') return e.devBase + rel;
  const r = reader;
  if (!r) throw notConnected(rel);
  let p = urls.get(rel);
  if (!p) {
    const g = gen;
    p = r.file(rel).then((f) => {
      if (!f) throw fileMissing(rel, 'not in the asset pack');
      if (g !== gen) throw notConnected(rel);
      return e.createObjectURL(f);
    });
    // the map this promise lives in: a late failure must not evict a newer pack's entry
    const cache = urls;
    const mine = p;
    p.catch(() => {
      if (cache.get(rel) === mine) cache.delete(rel);
    });
    urls.set(rel, p);
  }
  return p;
}

/** The pack has no such file (HTTP 404 in dev, no entry in the folder or archive). */
function fileMissing(rel: string, detail: string): Error {
  const err = new Error(`${rel}: ${detail}`);
  err.name = 'PackFileMissing';
  return err;
}

/**
 * The load failed because the file is not in the pack, not because reading it failed once
 * (dev server restart, a failed read from a folder handle, network). Only the first is final
 * for optional parts of a pack.
 */
export function isPackFileMissing(e: unknown): boolean {
  return e instanceof Error && e.name === 'PackFileMissing';
}

const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** Parsed JSON file of the pack (cached until the pack changes). */
export function fetchGameJson<T>(path: string): Promise<T> {
  start();
  let rel: string;
  try {
    rel = packPath(path);
  } catch (e) {
    // as gameAssetUrl: a bad path is a rejected promise, not a synchronous throw
    return Promise.reject(e);
  }
  let p = jsons.get(rel);
  if (!p) {
    p = (async () => {
      const s = await ready();
      if (s.status !== 'ready') throw notConnected(rel);
      if (s.source?.kind === 'dev') {
        const r = await getEnv().fetch(getEnv().devBase + rel);
        if (r.status === 404) throw fileMissing(rel, 'not in the asset pack (404)');
        if (!r.ok) throw new Error(`${rel}: ${r.status}`);
        return JSON.parse(stripBom(await r.text()));
      }
      const f = await reader?.file(rel);
      if (!f) throw fileMissing(rel, 'not in the asset pack');
      return JSON.parse(stripBom(await f.text()));
    })();
    const cache = jsons;
    const mine = p;
    p.catch(() => {
      if (cache.get(rel) === mine) cache.delete(rel);
    });
    jsons.set(rel, p);
  }
  return p as Promise<T>;
}

/** Whether the pack has this file (optional parts of a pack). */
export async function hasGameAsset(path: string): Promise<boolean> {
  start();
  let rel: string;
  try {
    rel = packPath(path);
  } catch {
    return false;
  }
  const s = await ready();
  if (s.status !== 'ready') return false;
  if (s.source?.kind === 'dev') {
    return !!(await head(getEnv(), getEnv().devBase + rel))?.ok;
  }
  try {
    return !!(await reader?.file(rel));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ browser environment
const DB = 'v-mirror-pack';
const STORE = 'handles';

function idbStore(): HandleStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  const open = () =>
    new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const tx = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    try {
      return await new Promise<T>((res, rej) => {
        const q = f(db.transaction(STORE, mode).objectStore(STORE));
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: async () => ((await tx('readonly', (s) => s.get('dir'))) as PackDirHandle | undefined) ?? null,
    set: async (h) => {
      // handles are structured-cloneable only where the File System Access API exists
      await tx<unknown>('readwrite', (s) => (h ? s.put(h, 'dir') : s.delete('dir')) as IDBRequest<unknown>);
    },
  };
}

/** No 'cancel' event: how long after focus returns an empty picker counts as cancelled. */
const CANCEL_GUESS_MS = 30_000;

function pickFilesInput(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    let done = false;
    const finish = (v: File[] | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => finish(input.files ? [...input.files] : null));
    input.addEventListener('cancel', () => finish(null));
    // Browsers without the 'cancel' event (older Safari, WebViews): the window gets focus back
    // when the dialog closes; if no files arrive long after that, it was cancelled. Browsers
    // that fire 'cancel' never use this guess: listing a big pack folder can take seconds,
    // and a real selection must not be dropped.
    if (!(typeof HTMLInputElement !== 'undefined' && 'oncancel' in HTMLInputElement.prototype)) {
      const onFocus = () => {
        window.removeEventListener('focus', onFocus);
        window.setTimeout(() => {
          if (!input.files?.length) finish(null);
        }, CANCEL_GUESS_MS);
      };
      window.setTimeout(() => window.addEventListener('focus', onFocus), 0);
    }
    document.body.appendChild(input);
    input.click();
  });
}

function browserEnv(): PackEnv {
  const w = typeof window !== 'undefined' ? (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<PackDirHandle> }) : undefined;
  const meta = import.meta.env ?? {};
  const base = (meta.BASE_URL as string | undefined) ?? '/';
  return {
    devPack: meta.VITE_DEV_PACK === 'true' || meta.VITE_DEV_PACK === true,
    devBase: base.replace(/\/?$/, '/') + 'game/',
    fetch: (...a) => fetch(...a),
    pickDirectory: w?.showDirectoryPicker ? () => w.showDirectoryPicker!({ id: 'v-mirror-pack', mode: 'read' }) : undefined,
    pickFiles: typeof document !== 'undefined' ? pickFilesInput : undefined,
    store: w?.showDirectoryPicker ? idbStore() : undefined,
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
  };
}

/** Tests only: fresh module state with a fake environment. */
export function __resetPackForTests(e: PackEnv | null) {
  gen++;
  attempt++;
  dropCaches();
  env = e;
  reader = null;
  rememberedHandle = null;
  state = { status: 'none' };
  started = false;
  settle = Promise.resolve();
  subs.clear();
}
