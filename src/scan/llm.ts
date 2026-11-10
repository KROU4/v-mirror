// Мультимодальная модель: промпт с каталогом вариантов, вызов OpenRouter, разбор ответа.
// Тот же промпт используется в «ручном режиме» — ответ можно вставить вручную
// (на этапе разработки роль модели выполнял ассистент).
import { getIndex, type Gender, type Loc, type Option, type Variant } from '../model/catalog';
import { MORPH_SLOTS, morphInfo } from '../model/descriptors';
import { hairDescriptions } from '../model/hair';
import { lookupSwatch, swatchTable } from '../ui/swatch';
import { browDescription } from '../model/brows';
import type { PhotoAnalysis } from './analyze';
import { colorKey, irisRing, type Suggestion } from './match';

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

/** Подпись части бороды в списке подбора (ru/en) */
const BEARD_PART_LOC: Record<string, Loc> = {
  '': { ru: 'полная (усы + подбородок + бакенбарды)', en: 'full (moustache + chin + sideburns)' },
  chin: { ru: 'только подбородок', en: 'chin only' },
  mustache: { ru: 'только усы', en: 'moustache only' },
  chin_mustache: { ru: 'подбородок + усы (эспаньолка)', en: 'chin + moustache (goatee)' },
  chin_sides: { ru: 'подбородок + бакенбарды, без усов', en: 'chin + sideburns, no moustache' },
  mustache_sides: { ru: 'усы + бакенбарды, без подбородка', en: 'moustache + sideburns, no chin' },
  sides: { ru: 'только бакенбарды', en: 'sideburns only' },
};

const pretty = (s: string) => s.replace(/_/g, ' ');

/** Тон кожи словами, от светлого к тёмному (по имени appearance игры). */
const SKIN_WORDS: Record<string, string> = {
  '01_ca_pale': 'pale (very light, pink undertone)',
  '01_ca_pale_00_warm_ivory': 'warm ivory (very light, warm undertone)',
  '02_ca_limestone': 'limestone (light, neutral)',
  '02_ca_limestone_00_beige': 'beige (light, yellow undertone)',
  '03_ca_senna': 'senna (light-medium, tan)',
  '03_ca_senna_00_amber': 'amber (medium, warm rosy)',
  '03_ca_senna_01_honey': 'honey (medium, golden)',
  '03_ca_senna_02_band': 'band (medium, olive)',
  '04_ca_almond': 'almond (medium-dark, light brown)',
  '04_ca_almond_00_umber': 'umber (medium-dark brown, warm)',
  '05_bl_espresso': 'espresso (dark brown)',
  '06_bl_dark': 'dark (very dark brown)',
};
const skinWords = (o: Option) => SKIN_WORDS[(o.app ?? '').split('__').pop() ?? ''] ?? o.label.en;

/** Явно неестественные радужки: линзы, кольца, кибер-глаза. */
const STYLISED_EYE = /multilayer|rebecca|cyber|ring|circle|stand|double|blood/i;
const stylisedEye = (o: Option) => STYLISED_EYE.test(o.label.en) || o.rating[1] >= 6;

/** Цвет волос словами (ключ цвета игры): то, как его назовёт человек. */
const HAIR_WORDS: Record<string, string> = {
  brown_liquorice: 'dark brown, almost black',
  blonde_platinum: 'platinum blond',
  red_merlot: 'deep auburn / dark red-brown',
  ginger_copper: 'copper ginger',
  teal_ombre: 'dyed teal ombre',
  black_carbon: 'jet black',
  blonde_golden: 'golden blond',
  blonde_dishwater: 'dark ash blond / light brown',
  blue_sapphire: 'dyed sapphire blue',
  brown_ombre: 'medium brown, lighter ends',
  red_apple: 'dyed bright red',
  gray_gunmetal: 'grey',
  ginger_strawberry: 'strawberry ginger',
  teal_ash: 'dyed ash teal',
  pink_magenta: 'dyed magenta',
  pink_rose: 'dyed dusty rose',
  blue_steel: 'dyed steel blue',
  blue_red_ombre: 'dyed red-to-blue ombre',
  cold_white: 'white / silver-grey',
  cyberpunk_yellow: 'dyed acid green-yellow',
  goblin_green: 'dyed green',
  liliac: 'dyed lilac',
  mermaid_aquamarine: 'dyed aquamarine',
  purple_ombre: 'dyed purple ombre',
  black_salt_n_pepper: 'salt-and-pepper (dark with grey)',
  green_toxic: 'dyed toxic green',
  brown_medium: 'medium brown',
  blue_sky: 'dyed sky blue',
  citrus_yellow: 'dyed citrus yellow',
  dark_purple: 'dyed dark purple',
  green_orange: 'dyed green-orange',
  liliac_ombre: 'dyed lilac ombre',
  phoenix_fire: 'dyed fiery orange',
  purple_blonde: 'dyed purple-blond',
  silver_rose: 'dyed silver rose',
};

/**
 * Цвет волос: название словами и самый светлый и самый тёмный тон образца игры. Образец —
 * миниатюра интерфейса, освещённая сверху вниз: это не «корни → кончики», и у блондинок
 * тёмный край — тень, а не тёмные кончики.
 */
export function hairWords(gender: Gender, slotId: string, o: Option): string {
  const d = lookupSwatch(swatchTable(gender), slotId, o);
  const stops = d?.stops ?? [];
  const words = HAIR_WORDS[colorKey(o)];
  const name = words ? `${o.label.en}: ${words}` : o.label.en;
  if (stops.length >= 2) return `${name} (light ${stops[0]}, shade ${stops[stops.length - 1]})`;
  return `${name} (${o.hex})`;
}

/** Естественные радужки словами: hex миниатюры у них вводит в заблуждение (карий #2c2b2c — серый). */
const EYE_WORDS: Record<string, string> = {
  gradient_brown: 'dark brown',
  gradient_blue: 'blue',
  gradient_black: 'near-black brown',
  gradient_green: 'green',
  gradient_grey: 'grey-blue',
  gradient_light_blue: 'light blue',
  gradient_red: 'red (albino-like)',
  gradient_violet: 'violet',
  gradient_yellow: 'amber / hazel-gold',
};

function eyeWords(gender: Gender, o: Option): string {
  const words = EYE_WORDS[colorKey(o)];
  if (words) return `${o.label.en}: ${words}`;
  // У стилизованных — основной цвет и цвет кольца радужки на образце (линзы Rebecca двухцветные)
  const ring = irisRing(gender, 'eyes_color', o) ?? o.iris;
  const col = ring && o.hex && ring !== o.hex ? `${o.hex}, iris ring ${ring}` : (ring ?? o.hex);
  return `${o.label.en} (${col})${stylisedEye(o) ? ' [stylised]' : ''}`;
}

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

export function buildPrompt(gender: Gender, a?: PhotoAnalysis | null, lang: 'ru' | 'en' = 'ru'): PromptPack {
  const language = lang === 'ru' ? 'Russian' : 'English';
  const idx = getIndex(gender);
  const parts: string[] = [];
  const slots: string[] = [];
  const add = (slotId: string, title: string, body: string) => {
    if (!idx.slotById.get(slotId)) return;
    slots.push(slotId);
    parts.push(`### ${slotId} — ${title}\n${body}`);
  };

  const hs = variantOf(gender, 'hairstyle', 'hairstyle');
  if (hs) {
    const desc = hairDescriptions(gender, hs.options);
    add('hairstyle', 'hairstyle', list(hs.options, (o, n) => `[${o.tags[0] ?? 'none'}] ${desc[n - 1].en}`));
  }
  const hc = variantOf(gender, 'hair_color');
  if (hc) {
    add(
      'hair_color',
      'hair colour (eyebrows, eyelashes and beard get the same colour unless you answer their own slots below)',
      list(hc.options, (o) => hairWords(gender, 'hair_color', o)),
    );
    // Брови и борода: палитры те же и в том же порядке, что у волос (номера совпадают)
    const sameAsHair = 'same numbering as hair_color; answer ONLY if clearly different from the hair (e.g. dark brows with blond hair, grey in the beard), otherwise omit';
    if (variantOf(gender, 'eyebrows_color')) add('eyebrows_color', `eyebrow colour — ${sameAsHair}`, '  (numbers 1…' + hc.options.length + ' as in hair_color)');
    if (gender === 'male' && variantOf(gender, 'beard_color')) add('beard_color', `beard colour — ${sameAsHair}`, '  (numbers 1…' + hc.options.length + ' as in hair_color)');
  }
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
  if (sk)
    add(
      'skin_color',
      'skin tone, from lightest to darkest (photo lighting makes skin look lighter; judge the real complexion and ethnicity, not the brightness of the photo)',
      list(sk.options, (o) => skinWords(o)),
    );
  const ec = variantOf(gender, 'eyes_color');
  if (ec) add('eyes_color', 'eye colour — natural ones first; only pick unnatural if the photo clearly shows coloured lenses', list(ec.options, (o) => eyeWords(gender, o)));

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
  if (lt) add('makeupLips_type', 'lip makeup type (1 = none)', list(lt.options, (o) => o.label.en));
  const lc = variantOf(gender, 'makeupLips_color', 'makeupLips_glossy_01') ?? variantOf(gender, 'makeupLips_color');
  if (lc) add('makeupLips_color', 'lipstick colour — only if lip makeup type is not 1 (none)', list(lc.options, (o) => `${o.label.en} (${o.hex})`));
  // Стиль макияжа глаз по номеру не угадать: у 36 стилей нет описаний формы. Модель сообщает
  // только, есть ли макияж (present.eyeMakeup) и его цвет; стиль пользователь выбирает сам
  // по подсказке (hints), а «нет макияжа» выставляется само
  const mc = variantOf(gender, 'makeupEyes_color', 'makeupEyes_01') ?? variantOf(gender, 'makeupEyes_color');
  if (mc) add('makeupEyes_color', 'eye makeup colour — only if eye makeup (liner, shadow, smoky) is clearly visible', list(mc.options, (o) => `${o.label.en} (${o.hex})`));

  const measured = !a
    ? ''
    : a.monochrome
      ? 'The photo is black-and-white: infer natural colours (skin, eyes, hair, lips) from the person, do not use measured hexes.'
      : [
          'Local measurements in the browser (hints only; photo lighting makes skin look lighter, so judge the real complexion):',
          a.colors.skin && `  skin (lit) ≈ ${a.colors.skin.hex}`,
          a.colors.iris && `  iris ≈ ${a.colors.iris.hex}`,
          a.colors.hair && `  hair at the hairline ≈ ${a.colors.hair.hex} (coverage ${(a.hairCoverage * 100).toFixed(0)}%)`,
          a.colors.brows && `  eyebrows ≈ ${a.colors.brows.hex}`,
          `  chin darker than cheeks score ${a.beardScore.toFixed(2)}; head yaw ${a.yaw.toFixed(0)}°, pitch ${a.pitch.toFixed(0)}°`,
        ]
          .filter(Boolean)
          .join('\n');

  const text = `You are matching a real person's photo to the Cyberpunk 2077 (patch 2.5) character creator for body type ${gender === 'male' ? '1 (masculine)' : '2 (feminine)'}.
For every slot below pick the option NUMBER (1-based, as listed) that makes V look most like the person. Judge real anatomy, not lighting. Prefer plausible natural options.
If a feature is not visible, omit that slot. Facial cyberware, face tattoos and piercings: only report presence.
${measured}

${parts.join('\n\n')}

Reply with ONLY a JSON object, no prose:
{"bodyType":"male|female","slots":{"<slotId>":{"n":<number>,"conf":<0..1>,"why":"<short reason in ${language}>"}},"beard_part":{"part":"full"},"present":{"facialHair":bool,"piercings":bool,"faceTattoo":bool,"eyeMakeup":bool,"cyberware":bool},"notes":"<one sentence in ${language}>"}
Write "why" and "notes" in ${language}: the user reads them.`;
  return { text, slots };
}

// ------------------------------------------------------------------ OpenRouter
export { callOpenRouter, DEFAULT_MODELS, listVisionModels, OpenRouterError, type ModelInfo } from './openrouter';

/** Answer of a model that cannot be read (code → UI text). */
export class LlmError extends Error {
  readonly code: 'noJson' | 'brokenJson';
  constructor(code: 'noJson' | 'brokenJson') {
    super(code === 'noJson' ? 'no JSON in the answer' : 'broken JSON in the answer');
    this.name = 'LlmError';
    this.code = code;
  }
}

// ------------------------------------------------------------------ разбор ответа
interface LlmJson {
  bodyType?: string;
  slots?: Record<string, { n?: number; conf?: number; why?: string } | null>;
  beard_part?: { part?: string };
  present?: Record<string, boolean>;
  notes?: unknown;
}

/** Все сбалансированные {...} верхнего уровня, с учётом строк и экранирования. */
function jsonBlocks(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = k;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) out.push(s.slice(start, k + 1));
    }
  }
  return out;
}

/** Убирает запятые перед } и ] вне строк (слабые модели их оставляют). */
function stripTrailingCommas(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    if (ch === ',') {
      let j = k + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseLoose(block: string): unknown {
  try {
    return JSON.parse(block);
  } catch {
    return JSON.parse(stripTrailingCommas(block));
  }
}

export function extractJson(text: string): LlmJson {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');
  const blocks = jsonBlocks(cleaned);
  // Незакрытая «{» в рассуждениях до ответа сбивает подсчёт глубины — тогда ищем от последнего
  // объекта, который начинается с ключа "slots"/"bodyType"
  const anchor = Math.max(cleaned.lastIndexOf('"slots"'), cleaned.lastIndexOf('"bodyType"'));
  if (anchor > 0) {
    for (let k = cleaned.lastIndexOf('{', anchor); k >= 0; k = cleaned.lastIndexOf('{', k - 1)) {
      const tail = jsonBlocks(cleaned.slice(k));
      if (tail.length) {
        blocks.push(...tail);
        break;
      }
    }
  }
  if (!blocks.length) throw new LlmError('noJson');
  let fallback: LlmJson | null = null;
  // Ответ обычно в конце: идём с последнего блока, предпочитаем тот, где есть slots
  for (let k = blocks.length - 1; k >= 0; k--) {
    let v: unknown;
    try {
      v = parseLoose(blocks[k]);
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if ('slots' in v) return v as LlmJson;
    fallback ??= v as LlmJson;
  }
  if (fallback) return fallback;
  throw new LlmError('brokenJson');
}

export interface LlmResult {
  suggestions: Suggestion[];
  bodyType?: Gender;
  notes?: string;
  /** что модель видит, но редактор не выставит сам (серьги, макияж без номера…) */
  hints?: Loc[];
}

/** Цвета, которые по умолчанию повторяют цвет волос (палитры у них общие с волосами). */
const HAIR_LINKED = ['eyebrows_color', 'eyelash_color', 'beard_color'] as const;

const toNum = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);

/**
 * @param allowed слоты, о которых спрашивал промпт (`PromptPack.slots`). Остальные
 *   ключи ответа игнорируются: модель не должна менять тело и скрытые слоты.
 */
export function parseLlm(gender: Gender, text: string, allowed?: readonly string[]): LlmResult {
  const j = extractJson(text);
  const idx = getIndex(gender);
  const out: Suggestion[] = [];
  const ok = allowed ? new Set(allowed) : null;
  const clampConf = (c: unknown) => {
    const x = toNum(c);
    return Math.max(0.05, Math.min(0.95, Number.isFinite(x) ? x : 0.5));
  };
  const slots = j.slots && typeof j.slots === 'object' && !Array.isArray(j.slots) ? j.slots : {};

  for (const [slotId, v] of Object.entries(slots)) {
    if (ok && !ok.has(slotId)) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const slot = idx.slotById.get(slotId);
    const raw = toNum(v.n);
    if (!slot || !Number.isFinite(raw)) continue;
    const variant = variantOf(gender, slotId);
    if (!variant) continue;
    const n = Math.round(raw);
    // 0, отрицательные и номера за пределами — это «не вижу/не знаю», а не вариант 1 или последний
    if (n < 1 || n > variant.options.length) continue;
    const o = variant.options[n - 1];
    const why = typeof v.why === 'string' ? v.why.slice(0, 200) : undefined;
    const s: Suggestion = { slotId, number: n, conf: clampConf(v.conf) * 0.95, src: 'llm', why };
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
  if (gender === 'male' && typeof part === 'string' && (!ok || ok.has('beard_part'))) {
    const key = part === 'full' ? '' : part;
    if (Object.hasOwn(BEARD_PART_LOC, key)) out.push({ slotId: 'beard_part', partKey: key, conf: 0.6, src: 'llm', why: BEARD_PART_LOC[key] });
  }

  // Брови, ресницы и борода: модель называет цвет волос, а их палитры общие (brown_liquorice,
  // black_salt_n_pepper…) — переносим тот же ключ, чуть менее уверенно. Ответ модели про
  // сами эти слоты (если он есть) уже в out и уверенности не теряет.
  const hair = out.find((x) => x.slotId === 'hair_color' && x.colorKey);
  if (hair) {
    for (const id of HAIR_LINKED) {
      if (!idx.slotById.get(id) || out.some((x) => x.slotId === id)) continue;
      out.push({ slotId: id, colorKey: hair.colorKey, hex: hair.hex, conf: hair.conf * 0.9, src: 'llm', why: { ru: 'как цвет волос', en: 'same as the hair colour' } });
    }
  }

  const pres = j.present && typeof j.present === 'object' && !Array.isArray(j.present) ? j.present : {};
  const hints: Loc[] = [];
  const answered = (id: string) => out.some((x) => x.slotId === id);
  const off = (slotId: string, why: Loc) => {
    const v = idx.slotById.get(slotId)?.variants[0];
    if (v) out.push({ slotId, value: v.options[0].i, conf: 0.7, src: 'llm', why });
  };
  if (pres.facialHair === false && gender === 'male') off('beard', { ru: 'без растительности на лице', en: 'no facial hair' });
  if (pres.piercings === false) off('piercings', { ru: 'пирсинга не видно', en: 'no piercings visible' });
  if (pres.faceTattoo === false) off('facial_tattoo_switcher', { ru: 'татуировок на лице нет', en: 'no face tattoos' });
  if (pres.eyeMakeup === false) off('makeupEyes', { ru: 'макияжа глаз нет', en: 'no eye makeup' });
  if (pres.cyberware === false) off('cyberware_switcher', { ru: 'имплантов на лице нет', en: 'no facial cyberware' });
  // «Есть», но без номера: сами не выбираем — показываем пользователю, что стоит проверить
  if (pres.piercings === true && !answered('piercings')) hints.push({ ru: 'На фото есть пирсинг или серьги — выберите их в строке «Пирсинг».', en: 'The photo shows piercings or earrings: pick them in the Piercings row.' });
  // Цвет макияжа глаз без стиля: при «нет макияжа» у строки цвета одна опция None, и ответ
  // модели выглядел бы применённым, а потом терялся при выборе стиля. Цвет уходит в подсказку
  const eyeCol = out.findIndex((x) => x.slotId === 'makeupEyes_color');
  let eyeColName: Loc | null = null;
  if (eyeCol >= 0 && (pres.eyeMakeup === false || !answered('makeupEyes'))) {
    const s = out[eyeCol];
    const mc = variantOf(gender, 'makeupEyes_color', 'makeupEyes_01') ?? variantOf(gender, 'makeupEyes_color');
    const o = s.number !== undefined ? mc?.options[s.number - 1] : undefined;
    if (o) eyeColName = o.label;
    out.splice(eyeCol, 1);
  }
  if (pres.eyeMakeup === true && !answered('makeupEyes'))
    hints.push(
      eyeColName
        ? { ru: `На фото есть макияж глаз — выберите стиль в строке «Макияж глаз», цвет: ${eyeColName.ru}.`, en: `The photo shows eye makeup: pick a style in the Eye makeup row; colour: ${eyeColName.en}.` }
        : { ru: 'На фото есть макияж глаз — выберите стиль и цвет в строке «Макияж глаз».', en: 'The photo shows eye makeup: pick a style and colour in the Eye makeup row.' },
    );
  if (pres.faceTattoo === true) hints.push({ ru: 'На лице есть татуировка — подберите похожую в строке «Татуировки лица».', en: 'There is a face tattoo: pick a similar one in the Facial tattoos row.' });
  if (pres.cyberware === true) hints.push({ ru: 'На лице есть импланты — подберите их в строке «Киберимпланты».', en: 'There is facial cyberware: pick it in the Cyberware row.' });

  const bodyType = j.bodyType === 'female' ? 'female' : j.bodyType === 'male' ? 'male' : undefined;
  // notes выводится в интерфейс как текст: не строка (например {}) уронила бы React
  const notes = typeof j.notes === 'string' && j.notes.trim() ? j.notes.slice(0, 500) : undefined;
  return { suggestions: out, bodyType, notes, hints: hints.length ? hints : undefined };
}

export async function photoToDataUrl(img: HTMLImageElement, max = 768): Promise<string> {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86);
}
