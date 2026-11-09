import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameAssetPath } from './vite.config';

describe('маршрут /game/*', () => {
  it('пускает вложенные пути разделов с разрешёнными расширениями', () => {
    expect(gameAssetPath('/glb/h0_000_pwa__morphs.morphtarget.glb')).toEqual({ file: path.join('tools/local/glb', 'h0_000_pwa__morphs.morphtarget.glb'), ext: 'glb' });
    expect(gameAssetPath('/tex/skin/manifest.json')?.ext).toBe('json');
    expect(gameAssetPath('/hair/cards/033/a/b.png')?.file).toBe(path.join('tools/local/hair', 'cards', '033', 'a', 'b.png'));
    expect(gameAssetPath('/renders/x.JPG')?.ext).toBe('jpg');
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
});
