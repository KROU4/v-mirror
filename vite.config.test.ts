import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { basePath, CSP, gameAssetPath, packSiteUrl, pushedHead, repoSlug, resolveCommit, stampPackScript } from './vite.config';
// @ts-expect-error a plain .mjs tool without type declarations
import { auditPackScript } from './tools/audit-dist.mjs';

describe('маршрут /game/*', () => {
  it('пускает вложенные пути разделов с разрешёнными расширениями', () => {
    expect(gameAssetPath('/glb/h0_000_pwa__morphs.morphtarget.glb')).toEqual({ file: path.join('tools/local/glb', 'h0_000_pwa__morphs.morphtarget.glb'), ext: 'glb' });
    expect(gameAssetPath('/tex/skin/manifest.json')?.ext).toBe('json');
    expect(gameAssetPath('/hair/cards/033/a/b.png')?.file).toBe(path.join('tools/local/hair', 'cards', '033', 'a', 'b.png'));
    expect(gameAssetPath('/renders/x.JPG')?.ext).toBe('jpg');
    expect(gameAssetPath('/swatches/icons/BrownLiquorice.webp')).toEqual({ file: path.join('tools/local/swatches', 'icons', 'BrownLiquorice.webp'), ext: 'webp' });
  });

  it('отклоняет выход из каталога, скрытые файлы и чужие расширения', () => {
    expect(gameAssetPath('/tex/../package.json')).toBeNull();
    expect(gameAssetPath('/tex/a..b/x.png')).toBeNull();
    expect(gameAssetPath('/tex/.hidden.png')).toBeNull();
    expect(gameAssetPath('/tex/x.exe')).toBeNull();
    expect(gameAssetPath('/tex/noext')).toBeNull();
    expect(gameAssetPath('/tex//x.png')).toBeNull();
  });

  it('только известные разделы, без имён из прототипа', () => {
    expect(gameAssetPath('/src/main.png')).toBeNull();
    expect(gameAssetPath('/constructor/x.png')).toBeNull();
    expect(gameAssetPath('/glb/x.constructor')).toBeNull();
    expect(gameAssetPath('glb/x.glb')).toBeNull();
  });

  it('глубина не больше 5 сегментов', () => {
    expect(gameAssetPath('/tex/1/2/3/4/x.png')).not.toBeNull();
    expect(gameAssetPath('/tex/1/2/3/4/5/x.png')).toBeNull();
  });

  it('отдаёт pack.json из корня набора', () => {
    expect(gameAssetPath('/pack.json')).toEqual({ file: path.join('tools/local', 'pack.json'), ext: 'json' });
    expect(gameAssetPath('/other.json')).toBeNull();
  });
});

describe('VITE_BASE', () => {
  it('нормализует базовый путь сборки', () => {
    expect(basePath(undefined)).toBe('/');
    expect(basePath('')).toBe('/');
    expect(basePath('v-mirror')).toBe('/v-mirror/');
    expect(basePath('/v-mirror')).toBe('/v-mirror/');
    expect(basePath('/a/b/')).toBe('/a/b/');
    expect(basePath('./')).toBe('./');
    expect(basePath('https://x.github.io/v')).toBe('https://x.github.io/v/');
  });
  it('отклоняет путь, который Git Bash превратил в путь Windows', () => {
    expect(() => basePath('C:/Program Files/Git/v-mirror/')).toThrow(/MSYS_NO_PATHCONV/);
    expect(() => basePath('/v mirror/')).toThrow();
  });
});

describe('pack.ps1: коммит сборки', () => {
  const SHA = 'a'.repeat(40);
  const script = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'pack.ps1'), 'utf8');

  it('коммит: GITHUB_SHA, затем git rev-parse HEAD, иначе main', () => {
    expect(resolveCommit({ GITHUB_SHA: SHA.toUpperCase() }, () => undefined)).toBe(SHA);
    expect(resolveCommit({}, () => `${'b'.repeat(40)}\n`)).toBe('b'.repeat(40));
    expect(resolveCommit({ GITHUB_SHA: 'abc' }, () => 'not a sha')).toBe('main');
    expect(resolveCommit({}, () => undefined)).toBe('main');
  });

  it('локальный HEAD — только если он есть на удалённой ветке (иначе codeload ответит 404)', () => {
    const B = 'b'.repeat(40);
    const fake = (contains: string | undefined) => (args: string[]) => (args[0] === 'rev-parse' ? `${B}\n` : contains);
    expect(pushedHead(fake('  origin/main\n'))).toBe(B);
    expect(pushedHead(fake(''))).toBeUndefined();
    expect(pushedHead(fake(undefined))).toBeUndefined();
    expect(pushedHead(() => undefined)).toBeUndefined();
  });

  it('адрес сайта для pack.ps1: VITE_SITE_URL, база проекта, иначе публичный сайт', () => {
    expect(packSiteUrl('https://example.org/vm', '/')).toBe('https://example.org/vm/');
    expect(packSiteUrl(undefined, '/v-mirror/')).toBe('https://krou4.github.io/v-mirror/');
    // локальная сборка с базой '/' не ведёт на https://krou4.github.io/
    expect(packSiteUrl(undefined, '/')).toBe('https://krou4.github.io/v-mirror/');
    expect(packSiteUrl('', '/')).toBe('https://krou4.github.io/v-mirror/');
  });

  it('репозиторий из VITE_REPO_URL', () => {
    expect(repoSlug('https://github.com/someone/fork')).toBe('someone/fork');
    expect(repoSlug('https://github.com/someone/fork.git')).toBe('someone/fork');
    expect(repoSlug(undefined)).toBe('KROU4/v-mirror');
    expect(repoSlug('https://gitlab.com/x/y')).toBe('KROU4/v-mirror');
  });

  it('ставит коммит, репозиторий и адрес сайта вместо заглушек; файл остаётся ASCII', () => {
    const out = stampPackScript(script, { commit: SHA, repo: 'KROU4/v-mirror', site: 'https://krou4.github.io/v-mirror/' });
    expect(out).toContain(`$commit = '${SHA}'`);
    expect(out).toContain("$repo = 'KROU4/v-mirror'");
    expect(out).toContain("$site = 'https://krou4.github.io/v-mirror/'");
    expect(out).not.toMatch(/__VMIRROR_(COMMIT|REPO|SITE)__/);
    expect(out).not.toMatch(/[^\x00-\x7e]/);
    expect(auditPackScript(out, { ci: true })).toEqual([]);
    // без коммита — ветка main, но только не в CI
    const main = stampPackScript(script, { commit: 'main', repo: 'KROU4/v-mirror', site: 'https://krou4.github.io/v-mirror/' });
    expect(auditPackScript(main)).toEqual([]);
    expect(auditPackScript(main, { ci: true })).toHaveLength(1);
  });

  it('не пропускает значения, которые выходят из строки PowerShell', () => {
    const ok = { commit: SHA, repo: 'KROU4/v-mirror', site: 'https://krou4.github.io/v-mirror/' };
    expect(() => stampPackScript(script, { ...ok, commit: "main'; calc; '" })).toThrow(/bad commit/);
    expect(() => stampPackScript(script, { ...ok, repo: "a/b'" })).toThrow(/bad repository/);
    expect(() => stampPackScript(script, { ...ok, site: "https://x/'$(calc)'/" })).toThrow(/bad site/);
    expect(() => stampPackScript('no placeholders', ok)).toThrow(/placeholder/);
  });

  it('исходный public/pack.ps1 — ASCII, с заглушками и запасными значениями', () => {
    expect(script).not.toMatch(/[^\x00-\x7e]/);
    expect(auditPackScript(script)).toHaveLength(1);
    expect(script).toContain("$commit = '__VMIRROR_COMMIT__'");
    expect(script).toContain('Set-StrictMode');
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });
});

describe('CSP сборки', () => {
  it('сеть — только сам сайт и openrouter.ai, wasm разрешён, eval нет', () => {
    expect(CSP).toMatch(/connect-src 'self' https:\/\/openrouter\.ai blob: data:/);
    expect(CSP).toMatch(/script-src 'self' 'wasm-unsafe-eval'(;|$)/);
    expect(CSP).not.toMatch(/'unsafe-eval'/);
    expect(CSP).not.toMatch(/googleapis/);
  });
});
