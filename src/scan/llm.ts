// Мультимодальная модель: промпт с каталогом вариантов, вызов OpenRouter, разбор ответа.
// Тот же промпт используется в «ручном режиме» — ответ можно вставить вручную.
import { getIndex, type Gender, type Loc, type Option, type Variant } from '../model/catalog';
import { MORPH_SLOTS, morphInfo } from '../model/descriptors';
import { hairDescription, hairDescriptions, isTwoTone } from '../model/hair';
import { lookupSwatch, swatchTable } from '../ui/swatch';
import { browDescription } from '../model/brows';
import { EYE_MAKEUP_FALLBACK, EYE_MAKEUP_STYLES, eyeMakeupStyleNo, eyeMakeupWords } from '../model/makeup';
import type { PhotoAnalysis } from './analyze';
import { beardStyleKey, colorHex, colorKey, heavyLidRows, irisRing, linkedColorKey, localSuggestions, PLAIN_RATING, type Suggestion } from './match';

/** Стили бороды словами — по кадрам 3D-редактора (полная часть, тёмный цвет). */
const BEARD_STYLE: Record<string, string> = {
  big_beard: 'long big full beard with a curled moustache',
  big_beard_afro: 'big bushy full beard with moustache',
  default: 'short neat full beard with moustache',
  handlebar_stache: 'handlebar moustache with a thin strap along the jaw and a soul patch',
  jesse_beard: 'medium full beard with moustache, covers cheeks and chin, bare patch under the lip',
  maelstrom_full: 'moustache and a long pointed chin beard, sparse cheeks',
  shadowbase_01: 'stubble / five o’clock shadow',
  short_afro: 'short scruffy full beard with moustache, patchy cheeks',
  thick_beard_afro: 'thick short full beard with moustache',
  fu_manchu: 'fu manchu moustache with long ends and a thin chin tuft',
  logan: 'mutton chops joined to the moustache, light chin',
  patmc: 'moustache with a goatee (van dyke), bare cheeks',
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

/**
 * Цвет помады словами (ключ цвета игры). Hex плашки ничего не говорил модели: Pastel Pink
 * (#904959) на V — яркий светлый «жвачный» розовый (глянец ещё светлее: 171, 89, 102 против
 * значка 142, 72, 87). Pink в игре — холодный лиловато-розовый (значок 117, 61, 79, тон 341°; на V
 * матовая 337°, глянец 353°), а не нюд: розово-бежевым губам (фото 246, 153, 148, тон 3°) ближе
 * Peach (на V 5°).
 */
export const LIP_WORDS: Record<string, string> = {
  black: 'black',
  blue: 'blue',
  gold: 'metallic gold',
  green: 'dark green',
  pink: 'cool mauve pink',
  red: 'brick red',
  violet: 'plum violet',
  white: 'grey-white',
  yellow: 'mustard yellow',
  peach: 'pink nude / coral peach (warm nude)',
  burgundy: 'deep wine',
  brown: 'dark brown',
  scarlet: 'vivid scarlet',
  pastel_pink: 'bright bubblegum pink',
};
const lipWords = (o: Option) => {
  const w = LIP_WORDS[colorKey(o)];
  return w ? `${o.label.en}: ${w}` : `${o.label.en} (${o.hex})`;
};

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

/**
 * Тип кожи (текстура лица, не тон) словами — по кадрам 3D-редактора (тон 07, крупный план носа),
 * ключ — meshHint опции. Тип 01 по умолчанию — с порами и пятнами (у мужчин — веснушки и
 * покраснение): без этой строки в промпте модель не могла выбрать чистую кожу, и у человека с
 * ровной кожей V выходила «грязной».
 */
export const SKIN_TYPE_WORDS: Record<Gender, Record<string, string>> = {
  female: {
    h0_000__basehead: 'default: pores, faint blotches, a few freckles',
    h0_000__basehead_d02: 'acne marks, blemishes',
    h0_000__basehead_d03: 'dense freckles and sun spots',
    h0_000__basehead_d04: 'smooth, clear, even',
    h0_000__basehead_d05: 'clear, rosy cheeks, beauty mark by the mouth',
  },
  male: {
    h0_000__basehead: 'default: pores, light freckles, red cheeks',
    h0_000__basehead_d02: 'acne scars, blemishes',
    h0_000__basehead_d03: 'weathered, freckled, blotchy, small scars',
    h0_000__basehead_d04: 'even, dark stubble shadow on lip and chin',
    h0_000__basehead_d05: 'smooth, rosy cheeks, beauty mark by the mouth',
  },
};
const skinTypeWords = (gender: Gender, o: Option) => {
  const h = typeof o.meshHint === 'string' ? o.meshHint : Array.isArray(o.meshHint) ? o.meshHint[0] : '';
  return SKIN_TYPE_WORDS[gender][h ?? ''] ?? o.label.en;
};

/** Явно неестественные радужки: линзы, кольца, кибер-глаза. */
const STYLISED_EYE = /multilayer|rebecca|cyber|ring|circle|stand|double|blood/i;
const stylisedEye = (o: Option) => STYLISED_EYE.test(o.label.en) || o.rating[1] >= 6;

/**
 * Цвет волос словами (ключ цвета игры): то, как его назовёт человек. Сверено с кадрами 3D-вида:
 * средний линейный цвет прядей против значка игры (Brown Liquorice — 55, 43, 35 против 52, 39, 32;
 * Black Carbon — 34, 29, 26 против 35, 27, 25; Red Merlot на длинной причёске 11 — 63, 31, 29 против
 * 58, 33, 27). Рендер совпадает со значком, поэтому слова — по тому, как цвет читается на V:
 * «почти чёрный» у Liquorice уводил к нему чёрные волосы, и V выходила тёплой шатенкой.
 */
export const HAIR_WORDS: Record<string, string> = {
  brown_liquorice: 'dark brown (brown on V, not black)',
  blonde_platinum: 'platinum blond',
  red_merlot: 'wine red / deep auburn (brown with a faint red cast: 1)',
  ginger_copper: 'orange copper, lighter than auburn',
  teal_ombre: 'dyed teal ombre',
  black_carbon: 'black / near-black',
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
  black_salt_n_pepper: 'salt-and-pepper, light grey on V',
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
  const words = HAIR_WORDS[colorKey(o)];
  const name = words ? `${o.label.en}: ${words}` : o.label.en;
  // Краска (оценка выше естественной) понятна по названию: тона образца только у естественных —
  // экономия токенов для бесплатных моделей
  if (o.rating[0] > PLAIN_RATING && words) return name;
  const d = lookupSwatch(swatchTable(gender), slotId, o);
  const stops = d?.stops ?? [];
  if (stops.length >= 2) return `${name} (light ${stops[0]}, shade ${stops[stops.length - 1]})`;
  return `${name} (${o.hex})`;
}

/** Множитель уверенности ответа модели с формой глаз «тяжёлые веки». */
export const HEAVY_LID_LLM_CONF = 0.5;

/**
 * Естественные радужки словами: hex миниатюры у них вводит в заблуждение (карий #2c2b2c — серый).
 * Слова сверены с радужкой игровой иконки (swatches.*.json, кольцо radial): «Gradient Black» —
 * тёмная сине-серая, а не чёрно-карая, карий в игре один — Gradient Brown.
 */
export const EYE_WORDS: Record<string, string> = {
  // единственный карий: на V средне-карий с кольцом, темнее естественного варианта нет
  gradient_brown: 'the only brown (medium on V): any brown or near-black eyes',
  gradient_blue: 'blue',
  gradient_black: 'dark blue-grey (not brown)',
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
  const col = ring && o.hex && ring !== o.hex ? `${o.hex}/${ring}` : (ring ?? o.hex);
  return `${o.label.en} (${col})`;
}

/**
 * Цвет глаз: естественные — по строке словами, стилизованные (линзы, кибер-глаза) — одной
 * строкой «номер название (цвет/кольцо)»: их 60 с лишним, и отдельные строки съедали ~1К токенов.
 */
function eyeColourList(gender: Gender, opts: Option[]): string {
  const natural: string[] = [];
  const styled: string[] = [];
  const blood: string[] = [];
  const multi: string[] = [];
  opts.forEach((o, k) => {
    if (EYE_WORDS[colorKey(o)] && !stylisedEye(o)) natural.push(`  ${k + 1}: ${eyeWords(gender, o)}`);
    // Кровавые версии естественных цветов — названием, без цвета; «Multilayer» — один раз на
    // группу (экономия ~800 символов промпта)
    else if (/^Blood Gradient /.test(o.label.en)) blood.push(`${k + 1} ${o.label.en.slice('Blood Gradient '.length)}`);
    else if (/^Multilayer /.test(o.label.en)) multi.push(`${k + 1} ${eyeWords(gender, o).slice('Multilayer '.length)}`);
    else styled.push(`${k + 1} ${eyeWords(gender, o)}`);
  });
  const groups: string[] = [];
  if (blood.length) groups.push(`bloodshot: ${blood.join(', ')}`);
  if (multi.length) groups.push(`multilayer lenses: ${multi.join('; ')}`);
  if (styled.length) groups.push(styled.join('; '));
  if (groups.length) natural.push(`  stylised lenses / cyber eyes, only if clearly visible: ${groups.join('; ')}`);
  return natural.join('\n');
}

/** Номера списком с диапазонами: 4, 10-18, 22. */
function ranges(nums: number[]): string {
  const out: string[] = [];
  for (let k = 0; k < nums.length; ) {
    let j = k;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > k ? `${nums[k]}-${nums[j]}` : `${nums[k]}`);
    k = j + 1;
  }
  return out.join(', ');
}

/**
 * Стили макияжа глаз: обычные — по строке с описанием формы, рисунки (молнии, полосы, надписи)
 * — одной строкой номеров: на обычном фото их не бывает, а описания всех 36 стилей не
 * помещаются в бюджет промпта.
 */
function eyeMakeupList(opts: Option[]): string {
  const plain: string[] = [];
  const graphic: number[] = [];
  opts.forEach((o, k) => {
    const no = eyeMakeupStyleNo(o);
    if (no && EYE_MAKEUP_STYLES[no]?.graphic) graphic.push(k + 1);
    else plain.push(`  ${k + 1}: ${eyeMakeupWords(o)}`);
  });
  if (graphic.length) plain.push(`  painted graphic designs (shapes, stripes, lettering): ${ranges(graphic)}`);
  return plain.join('\n');
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

/** «С цветом 3 причёска 21 двухцветная» / «…причёски: 21, 32» — для промпта. */
export function twoTonePhrase(colourNo: number, styles: readonly number[]): string {
  return styles.length === 1
    ? `With colour ${colourNo}, hairstyle ${styles[0]} is two-tone in the game`
    : `With colour ${colourNo}, these hairstyles are two-tone in the game: ${styles.join(', ')}`;
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
  const hc = variantOf(gender, 'hair_color');
  if (hs) {
    const desc = hairDescriptions(gender, hs.options);
    add(
      'hairstyle',
      'match the length first (where the ends fall: ears, jaw, collar, shoulders), then the sides (full, faded or shaved), then the parting and whether it is swept back, combed forward or messy; texture (straight, wavy, curly) last; receding/shaved front only if the photo shows it',
      list(hs.options, (o, n) => `[${o.tags[0] ?? 'none'}] ${desc[n - 1].en}`),
    );
  }
  if (hc) {
    // Двухцветные причёски для измеренного оттенка: с некоторыми цветами игра красит лишь концы
    // или пряди (длинные 32 + Red Merlot — каштан с бордовыми концами). Весь список пар не
    // помещается в бюджет промпта — называем только причёски, двухцветные с измеренным цветом
    const measuredKey = a && !a.monochrome ? localSuggestions(gender, a).find((s) => s.slotId === 'hair_color')?.colorKey : undefined;
    const measuredNo = measuredKey ? hc.options.findIndex((o) => colorKey(o) === measuredKey) + 1 : 0;
    const twoToneStyles = measuredNo && hs ? hs.options.flatMap((o, k) => (isTwoTone(gender, o, measuredKey!) ? [k + 1] : [])) : [];
    // Чем заменить двухцветную причёску, не меняя цвет: без этого модель с гладкими длинными
    // каштаново-рыжими волосами (32 + Red Merlot) уходила в Ginger Copper — другой цвет
    const swaps = hs
      ? twoToneStyles.flatMap((n) => {
          const alt = oneToneAlternative(gender, hs.options, hs.options[n - 1], measuredKey!);
          return alt ? [`${n}→${hs.options.indexOf(alt) + 1}`] : [];
        })
      : [];
    add(
      'hair_color',
      'hair colour (eyebrows, eyelashes and beard get the same colour unless you answer their own slots below)' +
        (twoToneStyles.length
          ? `. ${twoTonePhrase(measuredNo, twoToneStyles)} (only the ends or streaks dyed, the rest a natural shade): for hair that is one colour all over do not pair them — keep colour ${measuredNo} if it fits and take the nearest hairstyle outside this list` +
            (swaps.length ? ` (${swaps.join(', ')})` : '') +
            ', do not switch to another colour to avoid them'
          : ''),
      list(hc.options, (o) => hairWords(gender, 'hair_color', o)),
    );
    // Брови и борода: палитры те же и в том же порядке, что у волос (номера совпадают)
    const nums = '  (numbers 1…' + hc.options.length + ' as in hair_color)';
    if (variantOf(gender, 'eyebrows_color'))
      add(
        'eyebrows_color',
        'eyebrow colour — same numbering as hair_color; answer it whenever the brows differ from the hair (dyed, red, platinum or grey hair usually has darker natural brows); if omitted, a natural shade of the hair colour is used',
        nums,
      );
    if (gender === 'male' && variantOf(gender, 'beard_color'))
      add(
        'beard_color',
        'beard colour — same numbering as hair_color; answer ONLY if clearly different from the hair (e.g. a mostly grey beard; a few grey hairs are not), otherwise omit',
        nums,
      );
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
          const m = beardStyleKey(gender, o);
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
  const st = variantOf(gender, 'skin_type_switcher');
  if (st)
    add(
      'skin_type_switcher',
      'skin texture, not tone (freckles, spots, acne, redness): smooth clean skin on the photo is the clear option, not the default',
      list(st.options, (o) => skinTypeWords(gender, o)),
    );
  const ec = variantOf(gender, 'eyes_color');
  if (ec) add('eyes_color', 'eye colour — natural ones first; only pick unnatural if the photo clearly shows coloured lenses', eyeColourList(gender, ec.options));

  const heavyLids = heavyLidRows(gender);
  for (const slot of MORPH_SLOTS) {
    const info = morphInfo(gender, slot);
    const title =
      slot === 'eyes'
        ? 'eyes shape (relative to the game default; 1 = default). Judge the relaxed eye: a smile, squint or bright light narrows the eyes on a photo, so do not pick narrow or heavy-lidded shapes for that; most people fit a default-like or open shape'
        : `${slot} shape (described relative to the game default; 1 = default)`;
    const line = (text: string, n: number) => (slot === 'eyes' && heavyLids.has(n) ? `${text} — heavy upper lids, looks half-closed on V` : text);
    add(slot, title, info.options.map((o, k) => `  ${k + 1}: ${line(o.text.en, k + 1)}`).join('\n'));
  }
  const scars = variantOf(gender, 'scars');
  if (scars) add('scars', 'facial scars (1 = none)', list(scars.options, (o) => (o.app && o.app !== 'None' ? pretty(o.app.split('__').pop() ?? '') : 'none')));
  const cheeks = variantOf(gender, 'makeupCheeks');
  if (cheeks) {
    // Варианты без описаний формы — одной строкой диапазонов на вид (веснушки, румяна)
    const kind = (o: Option) => {
      const h = typeof o.meshHint === 'string' ? o.meshHint : '';
      return h.includes('freckles') ? 'freckles variants' : h.includes('cheeks') ? 'blush/contour variants' : 'none';
    };
    const groups = new Map<string, number[]>();
    cheeks.options.forEach((o, k) => groups.set(kind(o), [...(groups.get(kind(o)) ?? []), k + 1]));
    add('makeupCheeks', 'freckles / blush (1 = none)', [...groups].map(([w, nums]) => `  ${ranges(nums)}: ${w}`).join('\n'));
  }
  const lt = variantOf(gender, 'makeupLips_type');
  if (lt) add('makeupLips_type', 'lip makeup type (1 = none)', list(lt.options, (o) => o.label.en));
  const lc = variantOf(gender, 'makeupLips_color', 'makeupLips_glossy_01') ?? variantOf(gender, 'makeupLips_color');
  if (lc) add('makeupLips_color', 'lipstick colour — only if lip makeup type is not 1 (none)', list(lc.options, lipWords));
  // Макияж глаз: стиль — по описаниям формы декалей игры (обычные — по строке, рисунки — одной
  // строкой), цвет — отдельно. Ответ о стиле принимается только при present.eyeMakeup = true
  const me = variantOf(gender, 'makeupEyes');
  if (me) add('makeupEyes', 'eye makeup style (1 = none), only if clearly visible', eyeMakeupList(me.options));
  const mc = variantOf(gender, 'makeupEyes_color', 'makeupEyes_01') ?? variantOf(gender, 'makeupEyes_color');
  if (mc) add('makeupEyes_color', 'eye makeup colour, with a style', '  ' + mc.options.map((o, k) => `${k + 1} ${o.label.en} ${o.hex}`).join('; '));

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
    // Тяжёлые веки делают V сонным: такой ответ — с половинной уверенностью и пометкой
    if (slotId === 'eyes' && heavyLidRows(gender).has(n)) {
      s.conf *= HEAVY_LID_LLM_CONF;
      s.why = { ru: `${why ? `${why}; ` : ''}тяжёлые веки`, en: `${why ? `${why}; ` : ''}heavy upper lids` };
    }
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
  if (hair?.colorKey) {
    // Ресницы — за ответом о бровях, если он есть (палитры общие)
    const brows = out.find((x) => x.slotId === 'eyebrows_color' && x.colorKey);
    for (const id of HAIR_LINKED) {
      if (!idx.slotById.get(id) || out.some((x) => x.slotId === id)) continue;
      if (id === 'eyelash_color' && brows?.colorKey) {
        out.push({ slotId: id, colorKey: brows.colorKey, hex: brows.hex, conf: brows.conf * 0.9, src: 'llm', why: { ru: 'как цвет бровей', en: 'same as the brow colour' } });
        continue;
      }
      // Краска и седина волос на брови и ресницы не переносятся (linkedColorKey)
      const key = linkedColorKey(id, hair.colorKey);
      const same = key === hair.colorKey;
      out.push({
        slotId: id,
        colorKey: key,
        hex: same ? hair.hex : colorHex(gender, id, key) ?? hair.hex,
        conf: hair.conf * 0.9,
        src: 'llm',
        why: same ? { ru: 'как цвет волос', en: 'same as the hair colour' } : { ru: 'естественный тон под цвет волос', en: 'natural shade for this hair colour' },
      });
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
  if (pres.eyeMakeup === false) {
    // «нет макияжа» сильнее номера стиля: слабые модели ставят стиль и тут же пишут false
    for (let k = out.length - 1; k >= 0; k--) if (out[k].slotId === 'makeupEyes' || out[k].slotId === 'makeupEyes_color') out.splice(k, 1);
    off('makeupEyes', { ru: 'макияжа глаз нет', en: 'no eye makeup' });
  }
  if (pres.cyberware === false) off('cyberware_switcher', { ru: 'имплантов на лице нет', en: 'no facial cyberware' });
  // «Есть», но без номера: сами не выбираем — показываем пользователю, что стоит проверить
  if (pres.piercings === true && !answered('piercings')) hints.push({ ru: 'На фото есть пирсинг или серьги — выберите их в строке «Пирсинг».', en: 'The photo shows piercings or earrings: pick them in the Piercings row.' });
  applyEyeMakeup(gender, out, pres.eyeMakeup, hints);
  // Причёска и цвет, которые в игре дают двухцветные волосы (крашены лишь концы или пряди)
  const hsS = out.find((x) => x.slotId === 'hairstyle' && x.value !== undefined);
  if (hsS && hair?.colorKey) {
    const opts = idx.slotById.get('hairstyle')?.variants.find((v) => v.name === 'hairstyle')?.options ?? [];
    const o = opts.find((x) => x.i === hsS.value);
    if (o && isTwoTone(gender, o, hair.colorKey)) {
      // Модель сама говорит о крашеных концах или прядях — пара осознанная, оставляем
      const said = [hsS.why, hair.why].some((w) => typeof w === 'string' && TWO_TONE_WORDS.test(w));
      const alt = said ? null : oneToneAlternative(gender, opts, o, hair.colorKey);
      if (alt) {
        hsS.value = alt.i;
        hsS.conf *= 0.85;
        hints.push({
          ru: `Причёска ${o.label.ru} с этим цветом в игре красит только концы или пряди — выбрана похожая ${alt.label.ru}, окрашенная целиком. Если на фото крашены только концы, верните ${o.label.ru}.`,
          en: `Hairstyle ${o.label.en} dyes only the ends or streaks with this colour in the game, so the similar ${alt.label.en} (dyed all over) is used. If only the ends are dyed on the photo, switch back to ${o.label.en}.`,
        });
      } else
        hints.push({
          ru: `С причёской ${o.label.ru} этот цвет волос в игре красит только концы или пряди, остальное — естественный оттенок. Если волосы окрашены целиком, выберите другую причёску или цвет.`,
          en: `With hairstyle ${o.label.en} this hair colour dyes only the ends or streaks in the game; the rest stays a natural shade. If the hair is one colour all over, pick another hairstyle or colour.`,
        });
    }
  }
  if (pres.faceTattoo === true) hints.push({ ru: 'На лице есть татуировка — подберите похожую в строке «Татуировки лица».', en: 'There is a face tattoo: pick a similar one in the Facial tattoos row.' });
  if (pres.cyberware === true) hints.push({ ru: 'На лице есть импланты — подберите их в строке «Киберимпланты».', en: 'There is facial cyberware: pick it in the Cyberware row.' });

  const bodyType = j.bodyType === 'female' ? 'female' : j.bodyType === 'male' ? 'male' : undefined;
  // notes выводится в интерфейс как текст: не строка (например {}) уронила бы React
  const notes = typeof j.notes === 'string' && j.notes.trim() ? j.notes.slice(0, 500) : undefined;
  return { suggestions: out, bodyType, notes, hints: hints.length ? hints : undefined };
}

/**
 * Макияж глаз из ответа модели. Стиль и цвет принимаются, только если модель видит макияж
 * (present.eyeMakeup = true): номер стиля без этого флага — частая ошибка слабых моделей.
 * Макияж виден, а стиль не назван (или назван «нет») — ставится нейтральная подводка
 * (EYE_MAKEUP_FALLBACK) с цветом из ответа и низкой уверенностью, подсказка просит проверить.
 */
function applyEyeMakeup(gender: Gender, out: Suggestion[], present: boolean | undefined, hints: Loc[]) {
  const drop = (id: string) => {
    for (let k = out.length - 1; k >= 0; k--) if (out[k].slotId === id) out.splice(k, 1);
  };
  if (present === false) return; // «нет макияжа» уже выставлено
  if (present !== true) {
    drop('makeupEyes');
    drop('makeupEyes_color');
    return;
  }
  const me = variantOf(gender, 'makeupEyes');
  if (out.find((x) => x.slotId === 'makeupEyes')?.number === 1) drop('makeupEyes');
  if (!out.some((x) => x.slotId === 'makeupEyes') && me) {
    const k = me.options.findIndex((o) => eyeMakeupStyleNo(o) === EYE_MAKEUP_FALLBACK);
    if (k >= 0) {
      out.push({ slotId: 'makeupEyes', number: k + 1, conf: 0.25, src: 'llm', why: { ru: 'макияж виден, стиль не назван — тонкая подводка', en: 'eye makeup is visible, no style given: thin liner' } });
      hints.push({ ru: 'Стиль макияжа глаз подобран примерно — проверьте строку «Макияж глаз».', en: 'The eye makeup style is a rough guess: check the Eye makeup row.' });
    }
  }
  // Цвет не назван — чёрный (первый в палитре): без цвета слой макияжа не рисуется
  if (!out.some((x) => x.slotId === 'makeupEyes_color')) {
    const mc = variantOf(gender, 'makeupEyes_color', 'makeupEyes_01') ?? variantOf(gender, 'makeupEyes_color');
    const o = mc?.options[0];
    if (o?.app && o.hex) out.push({ slotId: 'makeupEyes_color', number: 1, colorKey: colorKey(o), hex: o.hex, conf: 0.2, src: 'llm', why: { ru: 'цвет не назван — чёрный', en: 'no colour given: black' } });
  }
}

/** Пояснение модели о частично окрашенных волосах (тогда двухцветная пара — её выбор). */
const TWO_TONE_WORDS = /ombre|ombré|\btips?\b|\bends?\b|streak|highlight|омбре|кончик|концы|пряд|мелир/i;

const STOP = new Set(['the', 'and', 'with', 'over', 'one', 'side', 'hair', 'past', 'off']);
/** «slicked» и «sleek» — одна гладкость; множественное число — то же слово (strands = strand). */
const SAME_WORD: Record<string, string> = { slicked: 'sleek' };
const stem = (w: string) => SAME_WORD[w] ?? (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).map(stem).filter((w) => w.length > 2 && !STOP.has(w)));
/**
 * Черты, которых не должно появиться у замены: выбритые зоны (женщине с гладкими длинными
 * волосами — полувыбритая голова), собранные волосы, чёлка, растрёпанность и особые формы.
 * Одна тонкая косичка — деталь, а не косы: длинные 32 (гладкие, без чёлки) с Red Merlot
 * заменяются на 11 (гладкие, зачёсаны набок, тонкая косичка сбоку), а не на 16 с чёлкой на глаза.
 */
const DISTINCT = [
  /shaved|undercut|buzz/,
  /updo|\bbuns?\b|ponytail|tied|knot/,
  /(?<!thin )\bbraids?\b|braided|cornrow|dread|twists/,
  /mohawk|mullet|spiky|spikes/,
  /bangs|fringe/,
  /messy|shaggy|tousled/,
  // прямым волосам не подставлять волны и кудри (32 → 65 «пышные волны» вместо гладких прямых 11)
  /wav[ey]|curl/,
];

/** Доля общих слов описания (Жаккар), с которой похожая причёска годится в замену. */
const ONE_TONE_MIN_SCORE = 0.2;

/**
 * Похожая причёска, которую этот цвет красит целиком: тот же класс длины (тег игры) и
 * больше всего общих слов в описании. null — такой нет.
 */
export function oneToneAlternative(gender: Gender, opts: readonly Option[], o: Option, colour: string): Option | null {
  const baseText = hairDescription(gender, o).en;
  const base = words(baseText);
  let best: Option | null = null;
  let bestScore = 0;
  for (const c of opts) {
    if (c === o || c.tags[0] !== o.tags[0] || isTwoTone(gender, c, colour)) continue;
    const text = hairDescription(gender, c).en;
    if (DISTINCT.some((re) => re.test(text) && !re.test(baseText))) continue;
    const w = words(text);
    let common = 0;
    for (const x of w) if (base.has(x)) common++;
    const score = common / Math.max(1, base.size + w.size - common);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= ONE_TONE_MIN_SCORE ? best : null;
}

export async function photoToDataUrl(img: HTMLImageElement, max = 768): Promise<string> {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86);
}
