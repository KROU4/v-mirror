import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { basePath, CSP, gameAssetPath } from './vite.config';

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

describe('CSP сборки', () => {
  it('сеть — только сам сайт и openrouter.ai, wasm разрешён, eval нет', () => {
    expect(CSP).toMatch(/connect-src 'self' https:\/\/openrouter\.ai blob: data:/);
    expect(CSP).toMatch(/script-src 'self' 'wasm-unsafe-eval'(;|$)/);
    expect(CSP).not.toMatch(/'unsafe-eval'/);
    expect(CSP).not.toMatch(/googleapis/);
  });
});
