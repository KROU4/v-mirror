import { describe, expect, it } from 'vitest';
import { buildPrompt, extractJson, parseLlm } from './llm';

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
    expect(() => extractJson('не знаю')).toThrow('В ответе нет JSON');
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
