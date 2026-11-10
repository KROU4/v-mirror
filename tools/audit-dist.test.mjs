import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditBaseGiven, auditDist, auditIndex, auditRepo, normalizeBase } from './audit-dist.mjs';
import { fnv1a64 } from './extract/pack.mjs';

const dirs = [];
function tree(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-audit-'));
  dirs.push(d);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('audit:dist', () => {
  it('accepts a clean build', () => {
    const dist = tree({
      'index.html': '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src x"><script src="/assets/index-abc.js"></script>',
      'assets/index-abc.js': 'x',
      'assets/tektur-latin.woff2': 'f',
      'portraits/v_pma.webp': 'w',
      'portraits/v_pwa.webp': 'w',
      'mediapipe/wasm/vision_wasm_internal.wasm': 'm',
      'mediapipe/face_landmarker.task': 't',
    });
    expect(auditDist(dist)).toEqual([]);
  });

  it('rejects meshes, game texture formats, pack folders and stray images', () => {
    const dist = tree({
      'assets/x.glb': 'g',
      'model.ktx2': 'k',
      'tex/skin/female/albedo_d01.jpg': 'j',
      'game/body/manifest.json': '{}',
      'pack.json': '{}',
      'img/hair.png': 'p',
    });
    const p = auditDist(dist).join('\n');
    expect(p).toMatch(/assets\/x\.glb: game asset format/);
    expect(p).toMatch(/model\.ktx2: game asset format/);
    expect(p).toMatch(/tex\/skin\/female\/albedo_d01\.jpg: asset-pack folder/);
    expect(p).toMatch(/game\/body\/manifest\.json: asset-pack folder/);
    expect(p).toMatch(/pack\.json: asset pack index/);
    expect(p).toMatch(/img\/hair\.png: unexpected image/);
  });

  it('finds byte copies of local pack files under any name', () => {
    const blob = 'B'.repeat(10000);
    const pack = tree({ 'tex/hair/cards/hh_long01_packed.png': blob });
    const dist = tree({ 'assets/innocent-1234.js': blob });
    expect(auditDist(dist, { pack }).join('\n')).toMatch(/byte copy of the local pack file tex\/hair\/cards\/hh_long01_packed\.png/);
  });
});

describe('index.html', () => {
  const csp = '<meta http-equiv="Content-Security-Policy" content="x">';
  it('accepts URLs under the base path', () => {
    expect(auditIndex(`${csp}<script src="/v-mirror/assets/a.js"></script><link href="https://x.y/z">`, '/v-mirror/')).toEqual([]);
  });
  it('reports a Git Bash path rewrite and URLs outside the base', () => {
    const p = auditIndex(`${csp}<script src="/C:/Program Files/Git/v-mirror/assets/a.js"></script>`, '/v-mirror/').join(' | ');
    expect(p).toMatch(/Windows path/);
    expect(p).toMatch(/outside the base path/);
  });
  it('requires the CSP meta tag', () => {
    expect(auditIndex('<script src="/a.js"></script>', '/').join()).toMatch(/Content-Security-Policy/);
  });
});

describe('--base / VITE_BASE', () => {
  it('normalises like basePath() in vite.config', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('v-mirror')).toBe('/v-mirror/');
    expect(normalizeBase('/v-mirror/')).toBe('/v-mirror/');
    expect(normalizeBase('./')).toBe('./');
    expect(normalizeBase('https://x.y/app')).toBe('https://x.y/app/');
  });
  it('a Git Bash path rewrite is an error with a hint, not false failures', () => {
    expect(() => normalizeBase('C:/Program Files/Git/v-mirror/')).toThrow(/MSYS_NO_PATHCONV/);
  });
});

describe('pack tool', () => {
  it('hashes depot paths like the game (FNV-1a 64, case-insensitive)', () => {
    const p = 'base\\characters\\head\\player_base_heads\\player_female_average\\he_000_pwa__morphs.morphtarget';
    expect(fnv1a64(p)).toBe(8931201215813019710n);
    expect(fnv1a64(p.toUpperCase())).toBe(fnv1a64(p));
  });
});

describe('audit: repository files', () => {
  it('passes the allowed public images and the big catalogs', () => {
    expect(
      auditRepo([
        { path: 'public/og.png', size: 500_000 },
        { path: 'public/favicon.svg', size: 300 },
        { path: 'public/portraits/v_pma.webp', size: 40_000 },
        { path: 'src/data/catalog.male.json', size: 3_000_000 },
        { path: 'src/App.tsx', size: 30_000 },
      ]),
    ).toEqual([]);
  });
  it('fails on renders, texture dumps, game formats and big files', () => {
    const p = auditRepo([
      { path: 'docs/render_front.png', size: 200_000 },
      { path: 'src/assets/skin_albedo.webp', size: 100_000 },
      { path: 'public/hair.glb', size: 10 },
      { path: 'src/data/huge.json', size: 2_000_000 },
    ]);
    expect(p).toHaveLength(4);
  });
});

describe('audit: base path in CI', () => {
  it('CI without VITE_BASE or --base fails, locally it is fine', () => {
    expect(auditBaseGiven({ GITHUB_ACTIONS: 'true' }, undefined)).toHaveLength(1);
    expect(auditBaseGiven({ GITHUB_ACTIONS: 'true', VITE_BASE: '/v-mirror/' }, undefined)).toEqual([]);
    expect(auditBaseGiven({ GITHUB_ACTIONS: 'true' }, '/v-mirror/')).toEqual([]);
    expect(auditBaseGiven({}, undefined)).toEqual([]);
  });
});
