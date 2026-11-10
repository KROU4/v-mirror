import { describe, expect, it } from 'vitest';
import { DICTS, detectLang, format, locText, translate, type MsgKey } from './index';
import { CATALOGS } from '../model/catalog';
import { visibleSlots, defaultState } from '../model/state';
import { LINES } from '../ui/lines';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('словари интерфейса', () => {
  const keys = Object.keys(DICTS.ru) as MsgKey[];

  it('у английского ровно те же ключи, что у русского', () => {
    expect(Object.keys(DICTS.en).sort()).toEqual([...keys].sort());
  });

  it('нет пустых строк ни в одном языке', () => {
    for (const lang of ['ru', 'en'] as const) for (const k of keys) expect(DICTS[lang][k].trim(), `${lang}:${k}`).not.toBe('');
  });

  it('подстановки совпадают в обоих языках', () => {
    for (const k of keys) expect(placeholders(DICTS.en[k]), k).toEqual(placeholders(DICTS.ru[k]));
  });

  it('английские строки без кириллицы (кроме названия языка)', () => {
    for (const k of keys) if (k !== 'lang.ru') expect(DICTS.en[k], k).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('подстановка значений и неизвестные метки', () => {
    expect(format('{a} из {b}', { a: 1, b: '02' })).toBe('1 из 02');
    expect(format('{a} {x}', { a: 1 })).toBe('1 {x}');
    expect(translate('en', 'info.count', { done: 3, total: 29 })).toBe('3 of 29 set');
    expect(translate('ru', 'info.count', { done: 3, total: 29 })).toBe('Всего 3 из 29');
  });

  it('язык по браузеру: ru-* — русский, остальное — английский', () => {
    expect(detectLang(['ru-RU', 'en-US'])).toBe('ru');
    expect(detectLang(['en-GB', 'ru'])).toBe('en');
    expect(detectLang(['de-DE', 'ru-RU'])).toBe('ru');
    expect(detectLang(['de-DE'])).toBe('en');
    expect(detectLang([])).toBe('en');
  });

  it('подписи каталога: запасной язык, если одного нет', () => {
    expect(locText({ ru: 'Нос', en: 'Nose' }, 'en')).toBe('Nose');
    expect(locText({ ru: 'Нос', en: '' }, 'en')).toBe('Нос');
    expect(locText('raw', 'ru')).toBe('raw');
    expect(locText(undefined, 'ru')).toBe('');
  });
});

describe('каталог на двух языках', () => {
  it('у каждого видимого слота и раздела списка есть ru и en', () => {
    for (const g of ['male', 'female'] as const) {
      for (const vs of visibleSlots(defaultState(g))) {
        expect(vs.slot.label.ru, `${g}:${vs.slot.id}`).not.toBe('');
        expect(vs.slot.label.en, `${g}:${vs.slot.id}`).not.toBe('');
        expect(vs.slot.label.en).not.toMatch(/[А-Яа-яЁё]/);
      }
    }
    for (const l of LINES) expect(l.label.en).toBeTruthy();
  });

  it('у именованных вариантов есть английское название из игры', () => {
    for (const g of ['male', 'female'] as const)
      for (const s of CATALOGS[g].slots)
        for (const v of s.variants)
          for (const o of v.options) {
            if (!o.label.ru) continue;
            expect(o.label.en, `${g}:${s.id}:${o.i}`).not.toBe('');
            expect(o.label.en, `${g}:${s.id}:${o.i}`).not.toMatch(/[А-Яа-яЁё]/);
          }
  });
});

describe('в разметке нет непереведённых строк', () => {
  // Клавиши русской раскладки (й, у, к, с, д, ч, п) — это не текст интерфейса
  const LAYOUT = /'[йукдсчп]'/g;
  const sources = import.meta.glob<string>(
    ['../App.tsx', '../scan/ScanPanel.tsx', '../scan/KeyPanel.tsx', '../ui/PackPanel.tsx', '../ui/SwatchChip.tsx', '../ui/Modal.tsx', '../ui/avatar/AvatarViewer.tsx'],
    { query: '?raw', import: 'default', eager: true },
  );
  it('проверяются все файлы разметки', () => expect(Object.keys(sources).length).toBe(7));
  for (const [f, src] of Object.entries(sources)) {
    it(f, () => {
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(LAYOUT, '');
      // AvatarViewer keeps its own two-language TEXT table
      const body = f.endsWith('AvatarViewer.tsx') ? code.replace(/const TEXT = \{[\s\S]*?\n\};/, '') : code;
      const hits = body.split('\n').filter((l) => /[А-Яа-яЁё]/.test(l));
      expect(hits).toEqual([]);
    });
  }
});
