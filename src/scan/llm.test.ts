import { describe, expect, it } from 'vitest';
import { buildPrompt, extractJson, LlmError, parseLlm } from './llm';

const pack = buildPrompt('male', null);
const nose = pack.slots.find((s) => s.startsWith('nose')) ?? pack.slots[0];

describe('разбор ответа модели', () => {
  it('берёт JSON после рассуждений и посторонних фигурных скобок', () => {
    const text = `<think>use {n} here, maybe {x}</think>Вот ответ: {"slots":{"${nose}":{"n":3}}} спасибо {x}`;
    expect(extractJson(text).slots?.[nose]?.n).toBe(3);
  });

  it('скобки внутри строк не ломают поиск блока', () => {
    const text = `{"slots":{"${nose}":{"n":2,"why":"нос {прямой}"}}}`;
    expect(extractJson(text).slots?.[nose]?.why).toBe('нос {прямой}');
  });

  it('прощает запятую перед закрывающей скобкой', () => {
    const text = '```json\n{"slots":{"' + nose + '":{"n":4,},},}\n```';
    expect(extractJson(text).slots?.[nose]?.n).toBe(4);
  });

  it('незакрытая скобка в рассуждениях не мешает найти ответ', () => {
    const text = `Думаю: { вариант носа ... Итог:\n{"bodyType":"male","slots":{"${nose}":{"n":6}}}`;
    expect(extractJson(text).slots?.[nose]?.n).toBe(6);
  });

  it('запятые внутри строк не трогаются при починке хвостовых запятых', () => {
    const text = `{"slots":{"${nose}":{"n":2,"why":"прямой,}"},},"notes":"a,]b",}`;
    const j = extractJson(text);
    expect(j.slots?.[nose]?.why).toBe('прямой,}');
    expect(j.notes).toBe('a,]b');
  });

  it('имена из прототипа не считаются частью бороды', () => {
    const r = parseLlm('male', '{"slots":{},"beard_part":{"part":"constructor"}}', pack.slots);
    expect(r.suggestions).toEqual([]);
  });

  it('понятная ошибка, если JSON нет', () => {
    expect(() => extractJson('не знаю')).toThrow(LlmError);
    try {
      extractJson('не знаю');
    } catch (e) {
      expect((e as LlmError).code).toBe('noJson');
    }
  });

  it('язык пояснений в промпте следует языку интерфейса', () => {
    expect(buildPrompt('male', null, 'en').text).toContain('"why" and "notes" in English');
    expect(buildPrompt('male', null, 'ru').text).toContain('"why" and "notes" in Russian');
  });

  it('пояснения разбора даны на обоих языках', () => {
    const r = parseLlm('male', '{"slots":{},"beard_part":{"part":"chin"},"present":{"piercings":false}}', pack.slots);
    const why = r.suggestions.map((s) => s.why);
    expect(why).toContainEqual({ ru: 'только подбородок', en: 'chin only' });
    expect(why).toContainEqual({ ru: 'пирсинга не видно', en: 'no piercings visible' });
  });

  it('принимает номер строкой', () => {
    const r = parseLlm('male', `{"slots":{"${nose}":{"n":"5","conf":"0.8"}}}`, pack.slots);
    expect(r.suggestions.find((s) => s.slotId === nose)?.number).toBe(5);
  });

  it('номер вне диапазона пропускается, а не зажимается', () => {
    const r = parseLlm('male', `{"slots":{"${nose}":{"n":0}}}`, pack.slots);
    expect(r.suggestions.some((s) => s.slotId === nose)).toBe(false);
    const r2 = parseLlm('male', `{"slots":{"${nose}":{"n":999}}}`, pack.slots);
    expect(r2.suggestions.some((s) => s.slotId === nose)).toBe(false);
  });

  it('слоты, о которых промпт не спрашивал, игнорируются', () => {
    const r = parseLlm('male', '{"slots":{"genitals_size":{"n":2}}}', pack.slots);
    expect(r.suggestions).toEqual([]);
  });

  it('неизвестная часть бороды игнорируется', () => {
    const r = parseLlm('male', '{"slots":{},"beard_part":{"part":"rm -rf"}}', pack.slots);
    expect(r.suggestions.some((s) => s.slotId === 'beard_part')).toBe(false);
  });
});

describe('промпт и ответ: цвета, макияж, мусор в ответе', () => {
  const fullPack = buildPrompt('male', null, 'en');

  it('кожа перечислена словами от светлой к тёмной, без «trust them for colours»', () => {
    expect(fullPack.text).toMatch(/1: pale \(very light/);
    expect(fullPack.text).toMatch(/12: dark \(very dark/);
    expect(fullPack.text).not.toMatch(/trust them for colours/);
  });

  it('у цветов волос — слова, светлый тон и тень образца (не «корни и кончики»), у неестественных глаз — пометка', () => {
    expect(fullPack.text).toMatch(/Brown Liquorice: dark brown, almost black \(light #[0-9a-f]{6}, shade #[0-9a-f]{6}\)/);
    expect(fullPack.text).toMatch(/platinum blond \(light #aea794/);
    expect(fullPack.text).not.toMatch(/roots #/);
    expect(fullPack.text).toMatch(/Cyber Eye \([^)]*\) \[stylised\]/);
    expect(fullPack.slots).toEqual(expect.arrayContaining(['makeupLips_color', 'makeupEyes_color']));
  });

  it('естественные глаза — словами, у линз Rebecca — их настоящие цвета', () => {
    const eyes = fullPack.text.split('### eyes_color')[1].split('###')[0];
    expect(eyes).toMatch(/1: [^\n]*: dark brown\n/);
    expect(eyes).not.toMatch(/1: [^\n]*#2c2b2c/);
    expect(eyes).toMatch(/Rebecca Pink \(#bf146b, iris ring #33ac12\)/);
  });

  it('стиль макияжа глаз не угадывается по номеру: только наличие и цвет', () => {
    expect(fullPack.slots).not.toContain('makeupEyes');
    const res = parseLlm('male', '{"slots":{"makeupEyes":{"n":5}},"present":{"eyeMakeup":true}}', fullPack.slots);
    expect(res.suggestions.some((s) => s.slotId === 'makeupEyes')).toBe(false);
    expect(res.hints?.length).toBe(1);
  });

  it('цвет бровей и бороды можно назвать отдельно от волос (та же нумерация)', () => {
    expect(fullPack.slots).toEqual(expect.arrayContaining(['eyebrows_color', 'beard_color']));
    expect(buildPrompt('female', null, 'en').slots).not.toContain('beard_color');
    const lines = fullPack.text.split('### hair_color')[1].split('\n');
    const n = (name: string) => lines.findIndex((l) => l.includes(name));
    const res = parseLlm('male', JSON.stringify({ slots: { hair_color: { n: n('Brown Liquorice'), conf: 0.8 }, beard_color: { n: n('Black Salt N Pepper'), conf: 0.6 }, eyebrows_color: { n: n('Brown Medium'), conf: 0.6 } } }), fullPack.slots);
    const key = (id: string) => res.suggestions.find((s) => s.slotId === id)?.colorKey;
    expect(key('hair_color')).toBe('brown_liquorice');
    expect(key('beard_color')).toBe('black_salt_n_pepper');
    expect(key('eyebrows_color')).toBe('brown_medium');
    expect(key('eyelash_color')).toBe('brown_liquorice');
  });

  it('ч/б фото: вместо замеров — просьба самим определить цвета', () => {
    const a = { monochrome: true, colors: {}, hairCoverage: 0, beardScore: 0, yaw: 0, pitch: 0 } as unknown as Parameters<typeof buildPrompt>[1];
    const t = buildPrompt('male', a, 'en').text;
    expect(t).toMatch(/black-and-white/);
    expect(t).not.toMatch(/skin \(lit\)/);
  });

  it('брови, ресницы и борода берут цвет волос из ответа модели', () => {
    const n = fullPack.text.split('### hair_color')[1].split('\n').findIndex((l) => l.includes('Black Salt N Pepper'));
    const res = parseLlm('male', JSON.stringify({ slots: { hair_color: { n, conf: 0.8 } } }), fullPack.slots);
    const hair = res.suggestions.find((s) => s.slotId === 'hair_color')!;
    for (const id of ['eyebrows_color', 'eyelash_color', 'beard_color']) {
      const s = res.suggestions.find((x) => x.slotId === id);
      expect(s?.colorKey, id).toBe(hair.colorKey);
      expect(s!.conf).toBeCloseTo(hair.conf * 0.9, 5);
    }
  });

  it('notes не строкой и мусорные слоты не роняют разбор', () => {
    const res = parseLlm('male', '{"slots":{"nose":null,"mouth":"x","jaw":{"n":2}},"notes":{}}', fullPack.slots);
    expect(res.notes).toBeUndefined();
    expect(res.suggestions.map((s) => s.slotId)).toContain('jaw');
  });

  it('«есть пирсинг / макияж глаз» без номера — подсказка пользователю, а не выбор', () => {
    const res = parseLlm('male', '{"slots":{},"present":{"piercings":true,"eyeMakeup":true}}', fullPack.slots);
    expect(res.hints?.length).toBe(2);
    expect(res.suggestions.find((s) => s.slotId === 'piercings')).toBeUndefined();
  });
});

describe('parseLlm: цвет макияжа глаз без стиля', () => {
  it('не применяется к строке, а уходит в подсказку с названием цвета', () => {
    const res = parseLlm('female', '{"slots":{"makeupEyes_color":{"n":1,"conf":0.6}},"present":{"eyeMakeup":true}}');
    expect(res.suggestions.some((s) => s.slotId === 'makeupEyes_color')).toBe(false);
    expect(res.hints?.some((h) => /цвет:/.test(h.ru) && /colour:/.test(h.en))).toBe(true);
  });
  it('при «макияжа нет» цвет тоже не применяется', () => {
    const res = parseLlm('female', '{"slots":{"makeupEyes_color":{"n":2}},"present":{"eyeMakeup":false}}');
    expect(res.suggestions.some((s) => s.slotId === 'makeupEyes_color')).toBe(false);
    expect(res.suggestions.some((s) => s.slotId === 'makeupEyes')).toBe(true);
  });
});
