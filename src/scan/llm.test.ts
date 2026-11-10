import { describe, expect, it } from 'vitest';
import { buildPrompt, EYE_WORDS, extractJson, HEAVY_LID_LLM_CONF, LlmError, parseLlm, twoTonePhrase } from './llm';
import { getIndex, type Gender } from '../model/catalog';
import { hairDescriptions, isTwoTone } from '../model/hair';
import { colorKey, heavyLidRows, irisRing } from './match';
import { hexToRgb, hueOf, rgbToLab } from './colors';
import type { PhotoAnalysis } from './analyze';

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
    // краска — только словами, без тонов образца (экономия токенов)
    expect(fullPack.text).toMatch(/Teal Ombre: dyed teal ombre\n/);
    expect(fullPack.text).toMatch(/stylised lenses \/ cyber eyes, only if clearly visible: [^\n]*\d+ Cyber Eye \(#[0-9a-f]{6}/);
    expect(fullPack.slots).toEqual(expect.arrayContaining(['makeupLips_color', 'makeupEyes_color']));
  });

  it('естественные глаза — словами, у линз Rebecca — их настоящие цвета', () => {
    const eyes = fullPack.text.split('### eyes_color')[1].split('###')[0];
    expect(eyes).toMatch(/1: [^\n]*: dark\/near-black brown\n/);
    expect(eyes).not.toMatch(/1: [^\n]*#2c2b2c/);
    expect(eyes).toMatch(/Rebecca Pink \(#bf146b\/#33ac12\)/);
    // стилизованные — одной строкой, а не 60 строк
    expect(eyes.trim().split('\n').length).toBeLessThan(14);
  });

  it('стиль макияжа глаз описан словами по форме декали; рисунки — одной строкой номеров', () => {
    const f = buildPrompt('female', null, 'en');
    expect(f.slots).toContain('makeupEyes');
    const me = f.text.split('### makeupEyes —')[1].split('###')[0];
    expect(me).toMatch(/\n  1: none\n/);
    // номер в промпте = подпись + 1 (1 — «нет»): 02 — стрелка, 20 — смоки
    expect(me).toMatch(/\n  3: winged cat-eye liner/);
    expect(me).toMatch(/\n  21: deep dark smoky/);
    expect(me).toMatch(/painted graphic designs \(shapes, stripes, lettering\): 4, 10-18, /);
    expect(me.trim().split('\n').length).toBeLessThan(16);
  });

  it('стиль макияжа глаз принимается только при present.eyeMakeup = true', () => {
    const yes = parseLlm('female', '{"slots":{"makeupEyes":{"n":21,"conf":0.7},"makeupEyes_color":{"n":1}},"present":{"eyeMakeup":true}}', fullPack.slots);
    expect(yes.suggestions.find((s) => s.slotId === 'makeupEyes')?.number).toBe(21);
    expect(yes.suggestions.find((s) => s.slotId === 'makeupEyes_color')?.colorKey).toBe('black');
    const unsure = parseLlm('female', '{"slots":{"makeupEyes":{"n":21},"makeupEyes_color":{"n":1}}}', fullPack.slots);
    expect(unsure.suggestions.some((s) => s.slotId === 'makeupEyes' || s.slotId === 'makeupEyes_color')).toBe(false);
    const no = parseLlm('female', '{"slots":{"makeupEyes":{"n":21}},"present":{"eyeMakeup":false}}', fullPack.slots);
    const off = no.suggestions.filter((s) => s.slotId === 'makeupEyes');
    expect(off).toHaveLength(1);
    expect(off[0].value).toBe(0);
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
    // ресницы следуют за ответом о бровях
    expect(key('eyelash_color')).toBe('brown_medium');
  });

  it('ч/б фото: вместо замеров — просьба самим определить цвета', () => {
    const a = { monochrome: true, colors: {}, hairCoverage: 0, beardScore: 0, yaw: 0, pitch: 0 } as unknown as Parameters<typeof buildPrompt>[1];
    const t = buildPrompt('male', a, 'en').text;
    expect(t).toMatch(/black-and-white/);
    expect(t).not.toMatch(/skin \(lit\)/);
  });

  it('брови, ресницы и борода берут цвет волос из ответа модели', () => {
    const n = fullPack.text.split('### hair_color')[1].split('\n').findIndex((l) => l.includes('Black Carbon'));
    const res = parseLlm('male', JSON.stringify({ slots: { hair_color: { n, conf: 0.8 } } }), fullPack.slots);
    const hair = res.suggestions.find((s) => s.slotId === 'hair_color')!;
    for (const id of ['eyebrows_color', 'eyelash_color', 'beard_color']) {
      const s = res.suggestions.find((x) => x.slotId === id);
      expect(s?.colorKey, id).toBe(hair.colorKey);
      expect(s!.conf).toBeCloseTo(hair.conf * 0.9, 5);
    }
  });

  it('седина и краска волос не переходят на брови и ресницы, седина остаётся в бороде', () => {
    const lines = fullPack.text.split('### hair_color')[1].split('\n');
    const n = (name: string) => lines.findIndex((l) => l.includes(name));
    const key = (r: ReturnType<typeof parseLlm>, id: string) => r.suggestions.find((s) => s.slotId === id)?.colorKey;
    const salt = parseLlm('male', JSON.stringify({ slots: { hair_color: { n: n('Black Salt N Pepper') } } }), fullPack.slots);
    expect(key(salt, 'eyebrows_color')).toBe('brown_liquorice');
    expect(key(salt, 'eyelash_color')).toBe('brown_liquorice');
    expect(key(salt, 'beard_color')).toBe('black_salt_n_pepper');
    const teal = parseLlm('male', JSON.stringify({ slots: { hair_color: { n: n('Teal Ombre') } } }), fullPack.slots);
    expect(key(teal, 'eyebrows_color')).toBe('brown_liquorice');
    expect(key(teal, 'beard_color')).toBe('brown_liquorice');
    const f = buildPrompt('female', null, 'en');
    const fl = f.text.split('### hair_color')[1].split('\n');
    const merlot = parseLlm('female', JSON.stringify({ slots: { hair_color: { n: fl.findIndex((l) => l.includes('Red Merlot')) } } }), f.slots);
    expect(key(merlot, 'hair_color')).toBe('red_merlot');
    expect(key(merlot, 'eyebrows_color')).toBe('brown_liquorice');
    const why = merlot.suggestions.find((s) => s.slotId === 'eyebrows_color')!.why as { en: string };
    expect(why.en).toMatch(/natural shade/);
  });

  it('формы глаз с тяжёлым веком помечены, а промпт просит судить по спокойному глазу', () => {
    const eyes = fullPack.text.split('### eyes —')[1].split('###')[0];
    expect(eyes).toMatch(/Judge the relaxed eye/);
    for (const n of heavyLidRows('male')) expect(eyes).toMatch(new RegExp(`\\n  ${n}: [^\\n]*looks half-closed on V`));
    expect(eyes).not.toMatch(/\n  1: [^\n]*half-closed/);
  });

  it('промпт компактный: укладывается в бюджет бесплатных моделей', () => {
    // ~4 символа на токен: держим промпт в пределах ~4,5К токенов
    expect(fullPack.text.length).toBeLessThan(18000);
    expect(buildPrompt('female', null, 'en').text.length).toBeLessThan(18000);
  });

  it('у каждой причёски, бороды и формы лица в промпте есть описание', () => {
    const hs = fullPack.text.split('### hairstyle')[1].split('###')[0];
    expect(hs).toMatch(/\n  37: \[Short\] medium length, swept back and to one side/);
    expect(hs).toMatch(/\n  41: \[Short\] short messy curls/);
    expect(hs).not.toMatch(/: \[[A-Za-z]+\] (short|long|hairstyle)\n/);
    const beard = fullPack.text.split('### beard —')[1].split('###')[0];
    expect(beard).toMatch(/\n  1: none, clean shaven/);
    expect(beard).toMatch(/medium full beard/);
    expect(beard).toMatch(/stubble/);
    for (const slot of ['nose', 'mouth', 'jaw']) {
      const body = fullPack.text.split(`### ${slot} —`)[1].split('###')[0];
      expect(body.trim().split('\n').length, slot).toBeGreaterThan(10);
    }
  });

  it('notes не строкой и мусорные слоты не роняют разбор', () => {
    const res = parseLlm('male', '{"slots":{"nose":null,"mouth":"x","jaw":{"n":2}},"notes":{}}', fullPack.slots);
    expect(res.notes).toBeUndefined();
    expect(res.suggestions.map((s) => s.slotId)).toContain('jaw');
  });

  it('«есть пирсинг» без номера — подсказка пользователю, а не выбор', () => {
    const res = parseLlm('male', '{"slots":{},"present":{"piercings":true}}', fullPack.slots);
    expect(res.hints?.length).toBe(1);
    expect(res.suggestions.find((s) => s.slotId === 'piercings')).toBeUndefined();
  });
});

describe('parseLlm: макияж глаз без стиля', () => {
  it('макияж виден, стиль не назван — тонкая подводка с цветом из ответа, низкая уверенность и подсказка', () => {
    const res = parseLlm('female', '{"slots":{"makeupEyes_color":{"n":6,"conf":0.6}},"present":{"eyeMakeup":true}}');
    const style = res.suggestions.find((s) => s.slotId === 'makeupEyes');
    expect(style?.number).toBe(9); // подпись 08 — тонкая подводка
    expect(style!.conf).toBeLessThan(0.4);
    expect(res.suggestions.find((s) => s.slotId === 'makeupEyes_color')?.colorKey).toBe('red');
    expect(res.hints?.some((h) => /Макияж глаз/.test(h.ru) && /Eye makeup/.test(h.en))).toBe(true);
  });
  it('без цвета — чёрный: слой без цвета не рисуется', () => {
    const res = parseLlm('female', '{"slots":{},"present":{"eyeMakeup":true}}');
    expect(res.suggestions.find((s) => s.slotId === 'makeupEyes_color')?.colorKey).toBe('black');
  });
  it('при «макияжа нет» цвет тоже не применяется', () => {
    const res = parseLlm('female', '{"slots":{"makeupEyes_color":{"n":2}},"present":{"eyeMakeup":false}}');
    expect(res.suggestions.some((s) => s.slotId === 'makeupEyes_color')).toBe(false);
    expect(res.suggestions.some((s) => s.slotId === 'makeupEyes')).toBe(true);
  });

describe('двухцветные причёски', () => {
  const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const photo = (c: Record<string, string>) =>
    ({
      monochrome: false,
      colors: Object.fromEntries(Object.entries(c).map(([k, hex]) => [k, { hex, rgb: hexRgb(hex) }])),
      features: {},
      blendshapes: {},
      yaw: 0,
      pitch: 0,
      beardScore: 0,
      lipstickScore: 0,
      hairCoverage: 0.9,
      hairSamples: 200,
    }) as unknown as PhotoAnalysis;

  it('с измеренным Red Merlot промпт называет причёски, где он красит только концы (женская 32)', () => {
    const f = buildPrompt('female', photo({ skin: '#f4a591', hair: '#512f2c', brows: '#754943' }), 'en');
    const colours = f.text.split('### hair_color —')[1].split('###')[0];
    const merlot = /\n  (\d+): [^\n]*[Mm]erlot/.exec(colours)?.[1];
    const m = /With colour (\d+), these hairstyles are two-tone in the game: ([\d, ]+)/.exec(colours);
    expect(m?.[1]).toBe(merlot);
    expect(m?.[2].split(', ').map(Number)).toContain(32);
    // без замера список не нужен
    expect(buildPrompt('female', null, 'en').text).not.toMatch(/are two-tone in the game/);
  });

  it('ответ «причёска 32 + Red Merlot»: берётся похожая причёска, окрашенная целиком, и подсказка с возвратом', () => {
    const f = buildPrompt('female', null, 'en');
    const colours = f.text.split('### hair_color —')[1].split('###')[0];
    const merlot = Number(/\n  (\d+): [^\n]*[Mm]erlot/.exec(colours)?.[1]);
    const opts = getIndex('female').slotById.get('hairstyle')!.variants.find((v) => v.name === 'hairstyle')!.options;
    const r = parseLlm('female', JSON.stringify({ slots: { hairstyle: { n: 32 }, hair_color: { n: merlot } } }), f.slots);
    const hs = r.suggestions.find((s) => s.slotId === 'hairstyle')!;
    const chosen = opts.find((o) => o.i === hs.value)!;
    expect(hs.value).not.toBe(opts[31].i);
    expect(isTwoTone('female', chosen, 'red_merlot')).toBe(false);
    expect(chosen.tags[0]).toBe(opts[31].tags[0]);
    expect(r.hints?.some((h) => /switch back to/.test(h.en) && /верните/.test(h.ru))).toBe(true);
    // модель сама пишет про крашеные концы — пара остаётся, но с подсказкой
    const r3 = parseLlm('female', JSON.stringify({ slots: { hairstyle: { n: 32 }, hair_color: { n: merlot, why: 'burgundy ombre, dyed ends' } } }), f.slots);
    expect(r3.suggestions.find((s) => s.slotId === 'hairstyle')?.value).toBe(opts[31].i);
    expect(r3.hints?.some((h) => /only the ends or streaks/.test(h.en))).toBe(true);
    const r2 = parseLlm('female', JSON.stringify({ slots: { hairstyle: { n: 32 }, hair_color: { n: 1 } } }), f.slots);
    expect(r2.suggestions.find((s) => s.slotId === 'hairstyle')?.value).toBe(opts[31].i);
    expect(r2.hints?.some((h) => /only the ends or streaks/.test(h.en)) ?? false).toBe(false);
  });

  it('цвета глаз словами совпадают с тоном радужки на игровой иконке', () => {
    for (const g of ['male', 'female'] as const) {
      const opts = getIndex(g).slotById.get('eyes_color')!.variants[0].options;
      for (const [key, words] of Object.entries(EYE_WORDS)) {
        const o = opts.find((x) => colorKey(x) === key);
        if (!o) continue;
        const lab = rgbToLab(hexToRgb(irisRing(g, 'eyes_color', o)!));
        const hue = hueOf(lab);
        // «brown» — тёплый тон (жёлто-красный сектор), «blue» без «brown» — холодный (b* < 0)
        if (/\bbrown\b/.test(words) && !/not brown/.test(words)) expect(hue, `${g} ${key} ${hue.toFixed(0)}°`).toBeGreaterThan(0);
        if (/\bbrown\b/.test(words) && !/not brown/.test(words)) expect(hue, `${g} ${key}`).toBeLessThan(100);
        if (/\bblue\b/.test(words) && !/(green|violet)/.test(words)) expect(lab[2], `${g} ${key} b*`).toBeLessThan(0);
      }
    }
    // карий — один: Gradient Brown, Gradient Black назван сине-серым
    expect(EYE_WORDS.gradient_black).toMatch(/blue-grey/);
    expect(EYE_WORDS.gradient_brown).toMatch(/near-black/);
    expect(buildPrompt('male', null, 'en').text).toMatch(/Gradient Black: dark blue-grey \(not brown\)/);
  });

  it('форма глаз «тяжёлые веки» от модели — с половинной уверенностью и пометкой', () => {
    const p = buildPrompt('male', null, 'en');
    const heavy = [...heavyLidRows('male')][0];
    const normal = [1, 2, 3, 4, 5].find((n) => !heavyLidRows('male').has(n))!;
    const r = parseLlm('male', JSON.stringify({ slots: { eyes: { n: heavy, conf: 0.8 } } }), p.slots);
    const s = r.suggestions.find((x) => x.slotId === 'eyes')!;
    expect(s.conf).toBeCloseTo(0.8 * 0.95 * HEAVY_LID_LLM_CONF, 5);
    expect(String(s.why)).toMatch(/heavy upper lids/);
    const r2 = parseLlm('male', JSON.stringify({ slots: { eyes: { n: normal, conf: 0.8 } } }), p.slots);
    expect(r2.suggestions.find((x) => x.slotId === 'eyes')!.conf).toBeCloseTo(0.8 * 0.95, 5);
  });

  it('причёски с голым лбом названы так в описании (залысины, выбритый перед)', () => {
    const bare: [Gender, string][] = [
      ['male', '122_roy'],
      ['male', '093_sumo'],
      ['female', '093_sumo'],
    ];
    for (const [g, stem] of bare) {
      const opts = getIndex(g).slotById.get('hairstyle')!.variants.find((v) => v.name === 'hairstyle')!.options;
      const k = opts.findIndex((o) => o.meshHint === stem);
      expect(k, `${g} ${stem}`).toBeGreaterThanOrEqual(0);
      const d = hairDescriptions(g, opts)[k];
      expect(d.en, `${g} ${stem}`).toMatch(/receding|shaved|bare/);
      expect(d.ru, `${g} ${stem}`).toMatch(/залысин|выбрит|голы/);
    }
    expect(buildPrompt('male', null, 'en').text).toMatch(/receding\/shaved front only if the photo shows it/);
  });

  it('фраза о двухцветных причёсках согласована по числу', () => {
    expect(twoTonePhrase(6, [21])).toBe('With colour 6, hairstyle 21 is two-tone in the game');
    expect(twoTonePhrase(3, [21, 32])).toBe('With colour 3, these hairstyles are two-tone in the game: 21, 32');
  });
});
});
