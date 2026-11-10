import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetOrForTests,
  callOpenRouter,
  checkKey,
  codeOfStatus,
  defaultModel,
  getOrSettings,
  looksLikeKey,
  OpenRouterError,
  runKeyCheck,
  setOrKey,
  visionModels,
} from './openrouter';

const res = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fake = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) =>
  (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return res(status, body);
  }) as unknown as typeof fetch;

const raw = (id: string, prompt: string, input = ['text', 'image'], output = ['text']) => ({
  id,
  name: id,
  architecture: { input_modalities: input, output_modalities: output },
  pricing: { prompt, completion: prompt },
});

describe('список моделей OpenRouter', () => {
  const list = visionModels([
    raw('paid/b', '0.000002'),
    raw('free/a:free', '0'),
    raw('text/only', '0', ['text']),
    raw('music/out', '0', ['text', 'image'], ['audio']),
    raw('openrouter/free', '0'),
    raw('paid/a', '0.000001'),
  ]);

  it('только вход-картинка и выход-текст, бесплатные первыми, потом по цене', () => {
    expect(list.map((m) => m.id)).toEqual(['free/a:free', 'paid/a', 'paid/b']);
    expect(list[0].free).toBe(true);
  });

  it('модель по умолчанию — предпочтительная бесплатная, иначе первая бесплатная', () => {
    expect(defaultModel(list)).toBe('free/a:free');
    expect(defaultModel([...list, { id: 'google/gemma-4-31b-it:free', name: 'g', free: true, pricePrompt: 0 }])).toBe('google/gemma-4-31b-it:free');
    expect(defaultModel(null)).toMatch(/:free$/);
  });
});

describe('ошибки OpenRouter', () => {
  it('статус → понятный код', () => {
    expect(codeOfStatus(401)).toBe('unauthorized');
    expect(codeOfStatus(402)).toBe('payment');
    expect(codeOfStatus(429)).toBe('rate');
    expect(codeOfStatus(404)).toBe('model');
    expect(codeOfStatus(500)).toBe('http');
  });

  it('401 при вызове модели — код unauthorized с текстом от сервера', async () => {
    const p = callOpenRouter({ key: 'k', model: 'm', imageDataUrl: 'data:', prompt: 'p', fetchImpl: fake(401, { error: { message: 'No auth' } }) });
    await expect(p).rejects.toMatchObject({ code: 'unauthorized', status: 401, detail: 'No auth' });
  });

  it('ошибка провайдера внутри ответа 200 не выдаётся за пустой ответ', async () => {
    const p = callOpenRouter({ key: 'k', model: 'm', imageDataUrl: 'data:', prompt: 'p', fetchImpl: fake(200, { error: { code: 429, message: 'busy' } }) });
    await expect(p).rejects.toMatchObject({ code: 'rate' });
  });

  it('обрыв сети — код network, отмена — AbortError', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(callOpenRouter({ key: 'k', model: 'm', imageDataUrl: '', prompt: '', fetchImpl: down })).rejects.toMatchObject({ code: 'network' });
    const aborted = (async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    await expect(callOpenRouter({ key: 'k', model: 'm', imageDataUrl: '', prompt: '', fetchImpl: aborted })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('текст ответа из массива частей', async () => {
    const text = await callOpenRouter({
      key: 'k',
      model: 'm',
      imageDataUrl: '',
      prompt: '',
      fetchImpl: fake(200, { choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } }] }),
    });
    expect(text).toBe('{"a":1}');
  });

  it('ключ уходит только на openrouter.ai в заголовке Authorization', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await callOpenRouter({ key: 'sk-or-v1-x', model: 'm', imageDataUrl: '', prompt: '', fetchImpl: fake(200, { choices: [{ message: { content: 'ok' } }] }, seen) });
    expect(seen.url).toMatch(/^https:\/\/openrouter\.ai\/api\/v1\//);
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-v1-x');
    expect(String(seen.init?.body)).not.toContain('sk-or-v1-x');
  });
});

describe('проверка ключа', () => {
  beforeEach(() => __resetOrForTests());

  it('GET /key: лимит, бесплатный тариф, имя ключа', async () => {
    const seen: { url?: string } = {};
    const info = await checkKey('sk-or-v1-abc', undefined, fake(200, { data: { label: 'my key', is_free_tier: true, limit_remaining: 4.5 } }, seen));
    expect(seen.url).toBe('https://openrouter.ai/api/v1/key');
    expect(info).toMatchObject({ label: 'my key', freeTier: true, limitRemaining: 4.5 });
  });

  it('имя ключа вида sk-or-… не показывается (это часть самого ключа)', async () => {
    const info = await checkKey('k', undefined, fake(200, { data: { label: 'sk-or-v1-abc...xyz', limit_remaining: null } }));
    expect(info.label).toBeUndefined();
    expect(info.limitRemaining).toBeNull();
  });

  it('состояние проверки: ok, затем сброс при смене ключа', async () => {
    setOrKey('  sk-or-v1-0123456789abcdef  ');
    expect(getOrSettings().key).toBe('sk-or-v1-0123456789abcdef');
    await runKeyCheck(fake(200, { data: { is_free_tier: false, limit_remaining: null } }));
    expect(getOrSettings().check.s).toBe('ok');
    setOrKey('sk-or-v1-other');
    expect(getOrSettings().check.s).toBe('idle');
    await runKeyCheck(fake(401, { error: { message: 'bad' } }));
    const c = getOrSettings().check;
    expect(c.s).toBe('fail');
    expect(c.s === 'fail' && c.err).toBeInstanceOf(OpenRouterError);
  });

  it('формат ключа', () => {
    expect(looksLikeKey('sk-or-v1-0123456789abcdef')).toBe(true);
    expect(looksLikeKey('sk-proj-123')).toBe(false);
  });
});

describe('где хранится ключ', () => {
  it('на общем домене github.io ключ по умолчанию не запоминается', async () => {
    const { rememberDefault, sharedOrigin } = await import('./openrouter');
    expect(sharedOrigin('krou4.github.io')).toBe(true);
    expect(sharedOrigin('v-mirror.example.com')).toBe(false);
    expect(rememberDefault('', true)).toBe(false);
    expect(rememberDefault('1', true)).toBe(true);
    expect(rememberDefault('', false)).toBe(true);
    expect(rememberDefault('0', false)).toBe(false);
  });
});
