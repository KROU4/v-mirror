// Путь «промпт → OpenRouter (подменённый fetch) → разбор → применение к персонажу» целиком,
// на ответах, которые хорошая мультимодальная модель даёт по референсам (Киану, Зендая).
import { describe, expect, it } from 'vitest';
import { getIndex, type Gender } from '../model/catalog';
import { defaultState, slotValue, type CharacterState } from '../model/state';
import { hairDescription, isTwoTone } from '../model/hair';
import { buildPrompt, callOpenRouter, parseLlm } from './llm';
import { applySuggestions, beardStyleKey, colorKey, mergeSuggestions } from './match';

const KEANU = {
  bodyType: 'male',
  slots: {
    hairstyle: { n: 37, conf: 0.6, why: 'medium length, ends at the collar' },
    hair_color: { n: 1, conf: 0.5, why: 'very dark brown' },
    eyebrows: { n: 1, conf: 0.5 },
    beard: { n: 6, conf: 0.7, why: 'medium full beard' },
    skin_color: { n: 4, conf: 0.3 },
    eyes_color: { n: 1, conf: 0.5 },
    eyes: { n: 2, conf: 0.4 },
    nose: { n: 10, conf: 0.35 },
    jaw: { n: 4, conf: 0.3 },
    makeupLips_type: { n: 1, conf: 0.8 },
  },
  beard_part: { part: 'full' },
  present: { facialHair: true, piercings: false, faceTattoo: false, eyeMakeup: false, cyberware: false },
  notes: 'monochrome photo',
};

const ZENDAYA = {
  bodyType: 'female',
  slots: {
    hairstyle: { n: 32, conf: 0.6 },
    hair_color: { n: 3, conf: 0.6, why: 'deep red-burgundy' },
    skin_color: { n: 7, conf: 0.45 },
    skin_type_switcher: { n: 4, conf: 0.5, why: 'smooth clear skin' },
    eyes: { n: 3, conf: 0.45 },
    makeupLips_type: { n: 3, conf: 0.6 },
    makeupLips_color: { n: 14, conf: 0.5 },
    makeupEyes_color: { n: 1, conf: 0.5 },
  },
  present: { facialHair: false, piercings: true, faceTattoo: false, eyeMakeup: true, cyberware: false },
};

/** fetch OpenRouter, отвечающий как слабая модель: рассуждение и JSON в блоке ```json. */
function fakeOpenRouter(answer: unknown, seen: { body?: { model: string; messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] } }) {
  return (async (_url: string, init?: RequestInit) => {
    seen.body = JSON.parse(String(init?.body));
    const content = 'Looking at the face {first impressions}\n```json\n' + JSON.stringify(answer, null, 1) + '\n```';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

async function scan(gender: Gender, answer: unknown) {
  const pack = buildPrompt(gender, null, 'en');
  const seen: Parameters<typeof fakeOpenRouter>[1] = {};
  const text = await callOpenRouter({ key: 'sk-or-v1-test', model: 'free/vision:free', imageDataUrl: 'data:image/jpeg;base64,AAAA', prompt: pack.text, fetchImpl: fakeOpenRouter(answer, seen) });
  const res = parseLlm(gender, text, pack.slots);
  const st = applySuggestions(defaultState(gender), mergeSuggestions(res.suggestions));
  return { pack, seen, res, st };
}

const pos = (st: CharacterState, slotId: string) => {
  const v = slotValue(st, slotId)!;
  return v.variant.options.findIndex((o) => o.i === v.value) + 1;
};
const key = (st: CharacterState, slotId: string) => colorKey(slotValue(st, slotId)!.option!);

describe('скан с моделью: промпт → fetch → разбор → персонаж', () => {
  it('Киану: причёска средней длины, тёмные волосы и брови, полная борода, глаза без тяжёлого века', async () => {
    const { pack, seen, res, st } = await scan('male', KEANU);
    // в запросе — сам промпт и фото
    expect(seen.body?.messages[0].content[0].text).toBe(pack.text);
    expect(seen.body?.messages[0].content[1].image_url?.url).toMatch(/^data:image\/jpeg/);
    expect(res.bodyType).toBe('male');

    expect(pos(st, 'hairstyle')).toBe(37);
    expect(hairDescription('male', slotValue(st, 'hairstyle')!.option!).en).toMatch(/medium length, tousled/);
    expect(key(st, 'hair_color')).toBe('brown_liquorice');
    expect(key(st, 'eyebrows_color')).toBe('brown_liquorice');
    expect(key(st, 'eyelash_color')).toBe('brown_liquorice');
    expect(beardStyleKey('male', slotValue(st, 'beard')!.option!)).toBe('jesse_beard');
    expect(key(st, 'beard_color')).toBe('brown_liquorice');
    expect(pos(st, 'eyes')).toBe(2);
    expect(pos(st, 'skin_color')).toBe(4);
  });

  it('Зендая: длинные гладкие волосы Red Merlot целиком, тёмные брови, глянцевые губы, подводка', async () => {
    const { st, res } = await scan('female', ZENDAYA);
    // 32 с Red Merlot в игре красит только концы: берётся похожая длинная прямая, окрашенная целиком
    const hs = slotValue(st, 'hairstyle')!.option!;
    expect(pos(st, 'hairstyle')).not.toBe(32);
    expect(isTwoTone('female', hs, 'red_merlot')).toBe(false);
    expect(hairDescription('female', hs).en).toMatch(/^straight, shoulder length/);
    expect(res.hints?.some((h) => /switch back to 32/.test(h.en))).toBe(true);
    expect(key(st, 'hair_color')).toBe('red_merlot');
    // брови модель не назвала — естественный тёмный тон, а не красное дерево
    expect(key(st, 'eyebrows_color')).toBe('brown_liquorice');
    expect(key(st, 'eyelash_color')).toBe('brown_liquorice');
    expect(pos(st, 'skin_color')).toBe(7);
    // чистая кожа — тип 04, а не тип 01 по умолчанию с порами и пятнами
    expect(pos(st, 'skin_type_switcher')).toBe(4);
    expect(pos(st, 'makeupLips_type')).toBe(3);
    expect(slotValue(st, 'makeupLips_color')!.option!.label.en).toBe('Pastel Pink');
    // макияж виден, стиль не назван — тонкая подводка (подпись 08) цвета из ответа
    expect(slotValue(st, 'makeupEyes')!.option!.label.en).toBe('08');
    expect(slotValue(st, 'makeupEyes_color')!.option!.label.en).toBe('Black');
    expect(res.hints?.some((h) => /Eye makeup row/.test(h.en))).toBe(true);
    expect(res.hints?.some((h) => /piercings/i.test(h.en))).toBe(true);
  });

  it('промпт описывает каждую причёску и бороду игры словами', () => {
    for (const g of ['male', 'female'] as const) {
      const hs = buildPrompt(g, null, 'en').text.split('### hairstyle')[1].split('###')[0];
      const n = getIndex(g).slotById.get('hairstyle')!.variants[0].options.length;
      expect(hs.trim().split('\n').length - 1, g).toBe(n);
    }
  });
});
