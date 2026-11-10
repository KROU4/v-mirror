import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetPackForTests,
  connectPackDirectory,
  disconnectPack,
  fetchGameJson,
  gameAssetUrl,
  getPackState,
  hasGameAsset,
  isPackFileMissing,
  packPath,
  restorePack,
  subscribePack,
  whenPackSettled,
  type HandleStore,
  type PackDirHandle,
  type PackEnv,
  type PackFileHandle,
  type PackState,
} from './pack';

// ------------------------------------------------------------------ fake File System Access handles
type Tree = { [name: string]: string | Tree };

function notFound(): Error {
  const e = new Error('not found');
  e.name = 'NotFoundError';
  return e;
}

class FakeDir implements PackDirHandle {
  kind = 'directory' as const;
  perm: PermissionState = 'granted';
  constructor(
    public name: string,
    private tree: Tree,
  ) {}
  async getDirectoryHandle(n: string): Promise<PackDirHandle> {
    const t = this.tree[n];
    if (t === undefined || typeof t === 'string') throw notFound();
    return new FakeDir(n, t);
  }
  async getFileHandle(n: string): Promise<PackFileHandle> {
    const t = this.tree[n];
    if (typeof t !== 'string') throw notFound();
    return { kind: 'file', name: n, getFile: async () => new File([t], n) };
  }
  async *values() {
    for (const [n, t] of Object.entries(this.tree)) {
      if (typeof t === 'string') yield { kind: 'file' as const, name: n, getFile: async () => new File([t], n) };
      else yield new FakeDir(n, t);
    }
  }
  async queryPermission() {
    return this.perm;
  }
  async requestPermission() {
    this.perm = 'granted';
    return this.perm;
  }
}

const PACK_JSON = JSON.stringify({ format: 1, gameVersion: '2.5', createdAt: '2026-11-10T00:00:00Z', files: 3 });
const packTree = (): Tree => ({
  'pack.json': PACK_JSON,
  body: { 'manifest.json': '﻿{"ok":true}' },
  glb: { 'x.glb': 'GLB' },
});

function memoryStore(initial: PackDirHandle | null = null): HandleStore & { value: PackDirHandle | null } {
  const s = {
    value: initial,
    get: async () => s.value,
    set: async (h: PackDirHandle | null) => {
      s.value = h;
    },
  };
  return s;
}

let blobs = 0;
const revoked: string[] = [];
function env(over: Partial<PackEnv> = {}): PackEnv {
  return {
    devPack: false,
    devBase: '/game/',
    fetch: async () => new Response('nope', { status: 404 }),
    createObjectURL: () => `blob:test/${++blobs}`,
    revokeObjectURL: (u) => {
      revoked.push(u);
    },
    ...over,
  };
}

afterEach(() => __resetPackForTests(null));

describe('packPath', () => {
  it('normalises leading slashes and the /game/ prefix', () => {
    expect(packPath('/glb/x.glb')).toBe('glb/x.glb');
    expect(packPath('game/body/manifest.json')).toBe('body/manifest.json');
  });
  it('rejects traversal and odd segments', () => {
    for (const p of ['', '../x', 'a/../b', 'a//b', 'a\\b', 'a/./b']) expect(() => packPath(p)).toThrow();
  });
});

describe('dev source', () => {
  it('uses the Vite /game/ route when the dev flag is set and the route answers', async () => {
    const fetch = async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url === '/game/body/manifest.json')
        return new Response('{"a":1}', { headers: { 'content-type': 'application/json' } });
      if (url === '/game/pack.json') return new Response('nope', { status: 404 });
      return new Response('{"v":2}', { headers: { 'content-type': 'application/json' } });
    };
    __resetPackForTests(env({ devPack: true, fetch }));
    expect(getPackState().status).toBe('connecting');
    const s = await whenPackSettled();
    expect(s).toMatchObject({ status: 'ready', source: { kind: 'dev' } });
    expect(await gameAssetUrl('glb/x.glb')).toBe('/game/glb/x.glb');
    expect(await fetchGameJson('tex/a.json')).toEqual({ v: 2 });
  });

  it('reads every HEAD response to the end (Chromium logs an unread one as ERR_ABORTED)', async () => {
    const heads: Response[] = [];
    const fetch = async (u: RequestInfo | URL, init?: RequestInit) => {
      const r = new Response(String(u).endsWith('pack.json') ? null : '{}', {
        status: String(u).endsWith('pack.json') ? 204 : 200,
        headers: { 'content-type': 'application/json' },
      });
      if (init?.method === 'HEAD') heads.push(r);
      return r;
    };
    __resetPackForTests(env({ devPack: true, fetch }));
    expect((await whenPackSettled()).status).toBe('ready');
    expect(await hasGameAsset('glb/x.glb')).toBe(true);
    expect(heads.length).toBe(2);
    expect(heads.every((r) => r.bodyUsed)).toBe(true);
  });

  it('a missing file (404) is told apart from a failed read, which is retried', async () => {
    let fail = true;
    const fetch = async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url === '/game/body/manifest.json') return new Response('{"a":1}', { headers: { 'content-type': 'application/json' } });
      if (url === '/game/pack.json') return new Response('nope', { status: 404 });
      if (url === '/game/body/intimate.json') return new Response('nope', { status: 404 });
      if (fail) return new Response('restarting', { status: 503 });
      return new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } });
    };
    __resetPackForTests(env({ devPack: true, fetch }));
    await whenPackSettled();
    const gone = await fetchGameJson('body/intimate.json').catch((e) => e);
    expect(isPackFileMissing(gone)).toBe(true);
    const once = await fetchGameJson('tex/face/decals.json').catch((e) => e);
    expect(isPackFileMissing(once)).toBe(false);
    // the failed read is not cached: the next request gets the file
    fail = false;
    expect(await fetchGameJson('tex/face/decals.json')).toEqual({ ok: 1 });
  });

  it('falls back to "none" when the dev route is missing', async () => {
    __resetPackForTests(env({ devPack: true }));
    expect((await whenPackSettled()).status).toBe('none');
    await expect(gameAssetUrl('glb/x.glb')).rejects.toThrow(/not connected/);
    expect(await hasGameAsset('glb/x.glb')).toBe(false);
  });
});

describe('directory source', () => {
  it('connects a picked folder, serves blob URLs, JSON and existence checks', async () => {
    const store = memoryStore();
    const dir = new FakeDir('my-pack', packTree());
    __resetPackForTests(env({ pickDirectory: async () => dir, store }));
    await whenPackSettled();
    const seen: string[] = [];
    subscribePack((s) => seen.push(s.status));
    await connectPackDirectory();
    const s = getPackState();
    expect(s).toMatchObject({ status: 'ready', source: { kind: 'dir', name: 'my-pack' } });
    expect(s.manifest?.gameVersion).toBe('2.5');
    expect(seen).toEqual(['connecting', 'ready']);
    expect(store.value).toBe(dir);

    const u1 = await gameAssetUrl('glb/x.glb');
    expect(u1).toMatch(/^blob:/);
    expect(await gameAssetUrl('/glb/x.glb')).toBe(u1); // cached
    expect(await fetchGameJson('body/manifest.json')).toEqual({ ok: true }); // BOM stripped
    expect(await hasGameAsset('glb/x.glb')).toBe(true);
    expect(await hasGameAsset('glb/missing.glb')).toBe(false);
    expect(await hasGameAsset('nope/missing.glb')).toBe(false);
    await expect(gameAssetUrl('glb/missing.glb')).rejects.toThrow(/not in the asset pack/);
    expect(isPackFileMissing(await gameAssetUrl('glb/missing.glb').catch((e) => e))).toBe(true);
    expect(isPackFileMissing(await fetchGameJson('body/missing.json').catch((e) => e))).toBe(true);

    disconnectPack();
    expect(getPackState().status).toBe('none');
    await new Promise((r) => setTimeout(r, 0));
    expect(revoked).toContain(u1);
    await expect(gameAssetUrl('glb/x.glb')).rejects.toThrow(/not connected/);
    expect(store.value).toBeNull();
  });

  it('accepts the parent folder of a pack', async () => {
    const dir = new FakeDir('downloads', { 'readme.txt': 'x', 'v-mirror-pack': packTree() });
    __resetPackForTests(env({ pickDirectory: async () => dir }));
    await connectPackDirectory();
    expect(getPackState()).toMatchObject({ status: 'ready', source: { kind: 'dir', name: 'downloads/v-mirror-pack' } });
    expect(await fetchGameJson('body/manifest.json')).toEqual({ ok: true });
  });

  it('reports folders that are not packs or have the wrong format', async () => {
    __resetPackForTests(env({ pickDirectory: async () => new FakeDir('photos', { 'a.jpg': 'x' }) }));
    await connectPackDirectory();
    expect(getPackState()).toMatchObject({ status: 'error' });
    expect(getPackState().error).toMatch(/pack\.json is missing/);

    __resetPackForTests(env({ pickDirectory: async () => new FakeDir('old', { ...packTree(), 'pack.json': '{"format":0}' }) }));
    await connectPackDirectory();
    expect(getPackState().error).toMatch(/Unsupported asset pack format/);

    const t = packTree();
    delete (t.body as Tree)['manifest.json'];
    __resetPackForTests(env({ pickDirectory: async () => new FakeDir('broken', t) }));
    await connectPackDirectory();
    expect(getPackState().error).toMatch(/incomplete/);
  });

  it('keeps the previous state when the picker is cancelled', async () => {
    let n = 0;
    const dir = new FakeDir('p', packTree());
    __resetPackForTests(
      env({
        pickDirectory: async () => {
          if (n++ === 0) return dir;
          const e = new Error('cancelled');
          e.name = 'AbortError';
          throw e;
        },
      }),
    );
    await connectPackDirectory();
    await connectPackDirectory();
    expect(getPackState()).toMatchObject({ status: 'ready', source: { kind: 'dir', name: 'p' } });
  });

  it('restores a remembered folder at startup when permission is still granted', async () => {
    const dir = new FakeDir('remembered', packTree());
    __resetPackForTests(env({ store: memoryStore(dir) }));
    const s = await whenPackSettled();
    expect(s).toMatchObject({ status: 'ready', source: { kind: 'dir', name: 'remembered' } });
  });

  it('offers to re-grant permission for a remembered folder', async () => {
    const dir = new FakeDir('remembered', packTree());
    dir.perm = 'prompt';
    __resetPackForTests(env({ store: memoryStore(dir) }));
    expect(await whenPackSettled()).toMatchObject({ status: 'none', remembered: 'remembered' });
    await restorePack();
    expect(getPackState()).toMatchObject({ status: 'ready', source: { kind: 'dir', name: 'remembered' } });
  });

  it('waits for a folder being checked before resolving URLs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class SlowDir extends FakeDir {
      async getFileHandle(n: string) {
        await gate;
        return super.getFileHandle(n);
      }
    }
    const dir = new SlowDir('slow', packTree());
    __resetPackForTests(env({ pickDirectory: async () => dir }));
    await whenPackSettled();
    const c = connectPackDirectory();
    await new Promise((r) => setTimeout(r, 0));
    expect(getPackState().status).toBe('connecting');
    const url = gameAssetUrl('glb/x.glb');
    release();
    await c;
    expect(await url).toMatch(/^blob:/);
  });

  it('does not touch the state while the picker is open, and keeps it when cancelled', async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const dir = new FakeDir('p', packTree());
    __resetPackForTests(
      env({
        pickDirectory: async () => {
          if (n++ === 0) return dir;
          await gate;
          const e = new Error('cancelled');
          e.name = 'AbortError';
          throw e;
        },
      }),
    );
    await connectPackDirectory();
    const before = getPackState();
    const seen: PackState[] = [];
    subscribePack((s) => seen.push(s));
    const c = connectPackDirectory();
    await new Promise((r) => setTimeout(r, 0));
    expect(getPackState()).toBe(before); // picker open: same object, same pack
    release();
    await c;
    expect(seen).toEqual([]);
    expect(getPackState()).toBe(before);
  });

  it('keeps the working pack when another folder turns out not to be a pack', async () => {
    let n = 0;
    const good = new FakeDir('good', packTree());
    const bad = new FakeDir('photos', { 'a.jpg': 'x' });
    __resetPackForTests(env({ pickDirectory: async () => (n++ === 0 ? good : bad) }));
    await connectPackDirectory();
    const id = getPackState().packId;
    const u1 = await gameAssetUrl('glb/x.glb');
    const seen: PackState[] = [];
    subscribePack((s) => seen.push(s));
    await connectPackDirectory();
    const s = getPackState();
    expect(s).toMatchObject({ status: 'ready', source: { kind: 'dir', name: 'good' }, packId: id });
    expect(s.lastError).toMatch(/pack\.json is missing/);
    expect(seen.every((x) => x.status === 'ready')).toBe(true);
    expect(await gameAssetUrl('glb/x.glb')).toBe(u1);
    expect(revoked).not.toContain(u1);
  });

  it('revokes blob URLs of the old pack when another one is connected', async () => {
    let n = 0;
    const a = new FakeDir('a', packTree());
    const b = new FakeDir('b', packTree());
    __resetPackForTests(env({ pickDirectory: async () => (n++ === 0 ? a : b) }));
    await connectPackDirectory();
    const id = getPackState().packId!;
    const u1 = await gameAssetUrl('glb/x.glb');
    await connectPackDirectory();
    expect(getPackState().packId).toBeGreaterThan(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(revoked).toContain(u1);
    expect(await gameAssetUrl('glb/x.glb')).not.toBe(u1);
  });

  it('a late failure of the old pack does not evict the new pack’s cache entry', async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class SlowFile extends FakeDir {
      async getDirectoryHandle(name: string) {
        if (name === 'glb') await gate;
        return super.getDirectoryHandle(name);
      }
    }
    const a = new SlowFile('a', packTree());
    const b = new FakeDir('b', packTree());
    __resetPackForTests(env({ pickDirectory: async () => (n++ === 0 ? a : b) }));
    await connectPackDirectory();
    const old = gameAssetUrl('glb/x.glb'); // in flight on pack a
    await connectPackDirectory(); // pack b
    const fresh = await gameAssetUrl('glb/x.glb');
    release();
    await expect(old).rejects.toThrow(/not connected/);
    expect(await gameAssetUrl('glb/x.glb')).toBe(fresh);
  });
});

describe('webkitdirectory fallback', () => {
  const file = (rel: string, body: string) => {
    const f = new File([body], rel.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: rel });
    return f;
  };

  it('re-roots at the folder holding pack.json', async () => {
    const files = [
      file('picked/pack/pack.json', PACK_JSON),
      file('picked/pack/body/manifest.json', '{"ok":1}'),
      file('picked/pack/glb/x.glb', 'GLB'),
      file('picked/other.txt', 'x'),
    ];
    __resetPackForTests(env({ pickFiles: async () => files }));
    await connectPackDirectory();
    expect(getPackState()).toMatchObject({ status: 'ready', source: { kind: 'dir', name: 'picked/pack' } });
    expect(await fetchGameJson('body/manifest.json')).toEqual({ ok: 1 });
    expect(await hasGameAsset('other.txt')).toBe(false);
  });

  it('treats an empty selection as cancel', async () => {
    __resetPackForTests(env({ pickFiles: async () => null }));
    await connectPackDirectory();
    expect(getPackState().status).toBe('none');
  });
});
