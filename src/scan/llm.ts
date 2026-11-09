// Мультимодальная модель: промпт с каталогом вариантов, вызов OpenRouter, разбор ответа.
// Тот же промпт используется в «ручном режиме» — ответ можно вставить вручную
// (на этапе разработки роль модели выполнял ассистент).
import { getIndex, type Gender, type Option, type Variant } from '../model/catalog';
import { MORPH_SLOTS, morphInfo } from '../model/descriptors';
import { hairDescription } from '../model/hair';
import { browDescription } from '../model/brows';
import type { PhotoAnalysis } from './analyze';
import { colorKey, type Suggestion } from './match';

const BEARD_STYLE: Record<string, string> = {
  big_beard: 'big full beard',
  big_beard_afro: 'big curly full beard',
  default: 'short neat beard',
  handlebar_stache: 'handlebar moustache only',
  jesse_beard: 'medium full beard',
  maelstrom_full: 'full rough uneven beard',
  shadowbase_01: 'stubble / five o’clock shadow',
  short_afro: 'short curly beard',
  thick_beard_afro: 'thick curly beard',
  fu_manchu: 'fu manchu moustache with long ends',
  logan: 'mutton chops with moustache',
  patmc: 'short scruffy beard',
};
const BEARD_PART: Record<string, string> = {
  '': 'full (moustache + chin + sides)',
  chin: 'chin only',
  mustache: 'moustache only',
  chin_mustache: 'chin + moustache (goatee)',
  chin_sides: 'chin + sideburns, no moustache',
  mustache_sides: 'moustache + sideburns, no chin',
  sides: 'sideburns only',
};

const pretty = (s: string) => s.replace(/_/g, ' ');

function variantOf(gender: Gender, slotId: string, name?: string): Variant | undefined {
  const s = getIndex(gender).slotById.get(slotId);
  if (!s) return undefined;
  if (name) return s.variants.find((v) => v.name === name);
  return s.variants.reduce<Variant | undefined>((a, v) => (!a || v.options.length > a.options.length ? v : a), undefined);
}

function list(opts: Option[], fn: (o: Option, n: number) => string): string {
  return opts.map((o, k) => `  ${k + 1}: ${fn(o, k + 1)}`).join('\n');
}

export interface PromptPack {
  text: string;
  slots: string[];
}

export function buildPrompt(gender: Gender, a?: PhotoAnalysis | null): PromptPack {
  const idx = getIndex(gender);
  const parts: string[] = [];
  const slots: string[] = [];
  const add = (slotId: string, title: string, body: string) => {
    if (!idx.slotById.get(slotId)) return;
    slots.push(slotId);
    parts.push(`### ${slotId} — ${title}\n${body}`);
  };

  const hs = variantOf(gender, 'hairstyle', 'hairstyle');
  if (hs) add('hairstyle', 'hairstyle', list(hs.options, (o) => `[${o.tags[0] ?? 'none'}] ${hairDescription(gender, o).en}`));
  const hc = variantOf(gender, 'hair_color');
  if (hc) add('hair_color', 'hair colour', list(hc.options, (o) => `${o.label.en} (${o.hex})`));
  const br = variantOf(gender, 'eyebrows');
  if (br) add('eyebrows', 'eyebrow shape (thickness, density, arch)', list(br.options, (o) => browDescription(o)?.en ?? o.label.en));

  if (gender === 'male') {
    const beard = variantOf(gender, 'beard');
    if (beard) {
      add(
        'beard',
        'facial hair style (1 = none)',
        list(beard.options, (o) => {
          const v = variantOf(gender, 'beard_part', o.activates?.[0]);
          const hint = v?.options[0]?.meshHint;
          const m = typeof hint === 'string' ? hint.split('__')[1] : '';
          return m ? BEARD_STYLE[m] ?? pretty(m) : 'none, clean shaven';
        }),
      );
      parts.push(
        '### beard_part — which parts of the chosen facial hair are kept (pick by meaning; numbering is per style):\n' +
          Object.entries(BEARD_PART).map(([k, v]) => `  ${k || 'full'}: ${v}`).join('\n') +
          '\nAnswer beard_part as {"part": "<one of: full, chin, mustache, chin_mustache, chin_sides, mustache_sides, sides>"}.',
      );
      slots.push('beard_part');
    }
  }

  const sk = variantOf(gender, 'skin_color');
  if (sk) add('skin_color', 'skin tone (game swatches, lighting-neutral)', list(sk.options, (o) => `${o.hex}`));
  const ec = variantOf(gender, 'eyes_color');
  if (ec) add('eyes_color', 'eye colour — natural ones first; only pick unnatural if the photo clearly shows coloured lenses', list(ec.options, (o) => `${o.label.en} (${o.iris ?? o.hex})${o.rating[0] > 3 ? ' [stylised]' : ''}`));

  for (const slot of MORPH_SLOTS) {
    const info = morphInfo(gender, slot);
    add(slot, `${slot} shape (described relative to the game default; 1 = default)`, info.options.map((o, k) => `  ${k + 1}: ${o.text.en}`).join('\n'));
  }
  const scars = variantOf(gender, 'scars');
  if (scars) add('scars', 'facial scars (1 = none)', list(scars.options, (o) => (o.app && o.app !== 'None' ? pretty(o.app.split('__').pop() ?? '') : 'none')));
  const cheeks = variantOf(gender, 'makeupCheeks');
  if (cheeks)
    add('makeupCheeks', 'freckles / blush (1 = none)', list(cheeks.options, (o) => {
      const h = typeof o.meshHint === 'string' ? o.meshHint : '';
      return h.includes('freckles') ? `freckles variant ${h.slice(-2)}` : h.includes('cheeks') ? `blush/contour ${h.slice(-2)}` : 'none';
    }));
  const lt = variantOf(gender, 'makeupLips_type');
  if (lt) add('makeupLips_type', 'lip makeup type', list(lt.options, (o) => o.label.en));

  const measured = a
    ? [
        'Local measurements (already done in the browser, trust them for colours):',
        a.colors.skin && `  skin ≈ ${a.colors.skin.hex}`,
        a.colors.iris && `  iris ≈ ${a.colors.iris.hex}`,
        a.colors.hair && `  hair above forehead ≈ ${a.colors.hair.hex} (coverage ${(a.hairCoverage * 100).toFixed(0)}%)`,
        a.colors.brows && `  eyebrows ≈ ${a.colors.brows.hex}`,
        `  chin darker than cheeks score ${a.beardScore.toFixed(2)}; head yaw ${a.yaw.toFixed(0)}°`,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const text = `You are matching a real person's photo to the Cyberpunk 2077 (patch 2.5) character creator for body type ${gender === 'male' ? '1 (masculine)' : '2 (feminine)'}.
For every slot below pick the option NUMBER (1-based, as listed) that makes V look most like the person. Judge real anatomy, not lighting. Prefer plausible natural options.
If a feature is not visible, omit that slot. Facial cyberware, face tattoos and piercings: only report presence.
${measured}

${parts.join('\n\n')}

Reply with ONLY a JSON object, no prose:
{"bodyType":"male|female","slots":{"<slotId>":{"n":<number>,"conf":<0..1>,"why":"<short reason>"}},"beard_part":{"part":"full"},"present":{"facialHair":bool,"piercings":bool,"faceTattoo":bool,"eyeMakeup":bool,"cyberware":bool},"notes":"<one sentence>"}`;
  return { text, slots };
}

// ------------------------------------------------------------------ OpenRouter
export interface ModelInfo {
  id: string;
  name: string;
  free: boolean;
  pricePrompt: number;
}

export const DEFAULT_MODELS = ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3.5-super-vl:free', 'qwen/qwen3.7-flash'];

export async function listVisionModels(): Promise<ModelInfo[]> {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error(`OpenRouter: ${r.status}`);
  const j = (await r.json()) as { data: { id: string; name: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] }; pricing?: { prompt: string; completion: string } }[] };
  return j.data
    .filter((m) => m.architecture?.input_modalities?.includes('image') && (m.architecture?.output_modalities ?? ['text']).includes('text'))
    .map((m) => ({
      id: m.id,
      name: m.name,
      free: m.pricing?.prompt === '0' && m.pricing?.completion === '0',
      pricePrompt: Number(m.pricing?.prompt ?? 0),
    }))
    .sort((x, y) => Number(y.free) - Number(x.free) || x.pricePrompt - y.pricePrompt);
}

export async function callOpenRouter(opts: { key: string; model: string; imageDataUrl: string; prompt: string; signal?: AbortSignal }): Promise<string> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${opts.key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'V-MIRROR',
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.prompt },
            { type: 'image_url', image_url: { url: opts.imageDataUrl } },
          ],
        },
      ],
    }),
  });
  const body = await r.text();
  if (!r.ok) {
    let msg = body.slice(0, 300);
    try {
      msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* не JSON */
    }
    throw new Error(r.status === 401 ? 'Ключ OpenRouter не принят (401). Проверьте ключ.' : r.status === 429 ? 'Лимит запросов модели исчерпан (429). Подождите или выберите другую модель.' : `OpenRouter ${r.status}: ${msg}`);
  }
  const j = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error('Модель вернула пустой ответ');
  return content;
}

// ------------------------------------------------------------------ разбор ответа
interface LlmJson {
  bodyType?: string;
  slots?: Record<string, { n?: number; conf?: number; why?: string }>;
  beard_part?: { part?: string };
  present?: Record<string, boolean>;
  notes?: string;
}

export function extractJson(text: string): LlmJson {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('В ответе нет JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as LlmJson;
}

export interface LlmResult {
  suggestions: Suggestion[];
  bodyType?: Gender;
  notes?: string;
}

export function parseLlm(gender: Gender, text: string): LlmResult {
  const j = extractJson(text);
  const idx = getIndex(gender);
  const out: Suggestion[] = [];
  const clampConf = (c?: number) => Math.max(0.05, Math.min(0.95, Number.isFinite(c) ? (c as number) : 0.5));

  for (const [slotId, v] of Object.entries(j.slots ?? {})) {
    const slot = idx.slotById.get(slotId);
    if (!slot || !Number.isFinite(v?.n)) continue;
    const variant = variantOf(gender, slotId)!;
    const n = Math.max(1, Math.min(variant.options.length, Math.round(v.n!)));
    const o = variant.options[n - 1];
    const s: Suggestion = { slotId, number: n, conf: clampConf(v.conf) * 0.95, src: 'llm', why: v.why };
    if (o?.app && (o.hex || o.iris)) {
      s.colorKey = colorKey(o);
      s.hex = o.iris ?? o.hex;
    }
    // Свитчер с одним вариантом (причёска, борода…): номер = позиция в нём
    if (slotId === 'hairstyle' || slotId === 'beard') {
      const main = slot.variants.find((x) => x.name === slotId) ?? slot.variants[0];
      s.value = main.options[n - 1]?.i;
      delete s.number;
    }
    out.push(s);
  }

  // Часть бороды — по смыслу (у каждого стиля свой набор частей)
  const part = j.beard_part?.part;
  if (gender === 'male' && part) {
    const key = part === 'full' ? '' : part;
    out.push({ slotId: 'beard_part', partKey: key, conf: 0.6, src: 'llm', why: BEARD_PART[key] ?? part });
  }

  const pres = j.present ?? {};
  const off = (slotId: string, why: string) => {
    const v = idx.slotById.get(slotId)?.variants[0];
    if (v) out.push({ slotId, value: v.options[0].i, conf: 0.7, src: 'llm', why });
  };
  if (pres.facialHair === false && gender === 'male') off('beard', 'без растительности на лице');
  if (pres.piercings === false) off('piercings', 'пирсинга не видно');
  if (pres.faceTattoo === false) off('facial_tattoo_switcher', 'татуировок на лице нет');
  if (pres.eyeMakeup === false) off('makeupEyes', 'макияжа глаз нет');
  if (pres.cyberware === false) off('cyberware_switcher', 'имплантов на лице нет');

  const bodyType = j.bodyType === 'female' ? 'female' : j.bodyType === 'male' ? 'male' : undefined;
  return { suggestions: out, bodyType, notes: j.notes };
}

export async function photoToDataUrl(img: HTMLImageElement, max = 768): Promise<string> {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86);
}
