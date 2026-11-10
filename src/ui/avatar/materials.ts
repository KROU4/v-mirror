// Материалы персонажа по манифестам выгрузки (tex/skin, tex/face, tex/hair, body).
// Стандартные PBR-материалы three.js + небольшие правки шейдера (onBeforeCompile):
// оттенок кожи по формуле skin.mt, детальные нормали, «подповерхностное» мягкое
// освещение кожи, цвет прядей из рамп профиля волос, LUT-декаль скальпа, брови.
import * as THREE from 'three';
import type {
  AssetStore,
  BodyTexSet,
  BrowColour,
  BrowStyle,
  EyeEntry,
  FaceDecalMat,
  HairManifest,
  PiercingMat,
  HairMaterial,
  LashEntry,
  NailMat,
  SkinGender,
  TeethEntry,
} from './assets';
import type { IntimateDecalMat, IntimateSkinMat } from './intimate';

type Shader = THREE.WebGLProgramParametersWithUniforms;

/**
 * Контровой свет (всё в осях камеры). lightBehind: 1 — лампа за спиной V (направление на
 * неё смотрит от камеры, L.z < 0). rimMask: такая лампа освещает только грани у силуэта
 * (N.z < ~0,1); обращённые к камере стенки носа, складки век, ноздри и ушная раковина ей
 * закрыты самой головой.
 */
const RIM_MASK_GLSL = `
float lightBehind( float lightZ ) {
	return 1.0 - smoothstep( -0.35, 0.05, lightZ );
}
float rimMask( float lightZ, float normalZ ) {
	return 1.0 - lightBehind( lightZ ) * smoothstep( -0.12, 0.15, normalZ );
}
`;

/**
 * Мягкое освещение кожи: свет «заворачивает» за терминатор (свет под кожей), а диффузная
 * часть считается по нормали, смешанной с нормалью геометрии (gSoftN, доля uSoftN): в игре
 * экранное подповерхностное рассеяние размывает рельеф карты нормалей в диффузе, а с полной
 * картой стенка носа, носогубные складки и нижние веки ложились тёмно-бурыми полосами.
 * Блик считается по полной нормали — поры и складки на нём остаются.
 * MOUTH_OCCLUSION (зубы и язык): свет внутри рта гасится по глубине рта и по тому,
 * насколько разомкнуты губы; лампы из-за спины V (контровые) в рот не попадают вовсе.
 * Контровой свет (лампа дальше от камеры, чем V) кожу освещает только у силуэта: на
 * обращённых к камере участках (ноздри, складка века, уголки губ) его закрывает сама голова.
 * Одной тени контровой лампы для этого мало: на «завёрнутом» свете у обращённых к камере
 * участков её граница режет лицо полосой (висок — щека — челюсть). Блик от контровых ламп
 * ослаблен: скользящий GGX на почти боковых гранях (стенка носа при повороте головы) даёт
 * белую с голубым полосу, а в игре контровой на коже — мягкая цветная кайма.
 */
const SKIN_LIGHTS = (RIM_MASK_GLSL + THREE.ShaderChunk.lights_physical_pars_fragment)
  .replace(
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
    `#ifdef SKIN_SSS
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * mix( 1.0, 0.2, lightBehind( directLight.direction.z ) ) * gCrease;
#else
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;
#endif`,
  )
  .replace(
    'vec3 irradiance = dotNL * directLight.color;',
    `float mouthK = 1.0;
	vec3 lightCol = directLight.color;
#ifdef SKIN_SSS
	mouthK *= rimMask( directLight.direction.z, geometryNormal.z );
#endif
#ifdef SKIN_EAR
	// тонкие завитки уха смотрят назад, на контровые лампы, и горят точками
	mouthK *= 1.0 - 0.75 * gEarMask * lightBehind( directLight.direction.z );
#endif
#ifdef MOUTH_OCCLUSION
	// глубина рта: боковые зубы в улыбке приглушены, но не до серо-оливковой черноты
	mouthK *= uMouthLight * mix( 1.0, 0.55, gMouthDepth ) * smoothstep( -0.25, 0.35, directLight.direction.z );
	// Во рту остаётся рассеянный свет без оттенка ламп: голубой Fill иначе красит зубы в серо-зелёный
	lightCol = mix( vec3( dot( lightCol, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 1.0, 0.96, 0.92 ), lightCol, 0.1 );
#endif
	lightCol *= mouthK;
	vec3 irradiance = dotNL * lightCol;`,
  )
  .replace(
    'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );',
    `#ifdef SKIN_SSS
	// диффузный свет — по смягчённой нормали (свет под кожей размывает рельеф карты)
	float softNL = dot( gSoftN, directLight.direction );
	float wrapNL = saturate( ( softNL + 0.4 ) / 1.4 );
	vec3 sssIrr = mix( vec3( saturate( softNL ) ), vec3( wrapNL ), gScatter ) * lightCol;
	reflectedLight.directDiffuse += sssIrr * diffuseBRDF * ( 1.0 - F );
#else
	reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );
#endif`,
  );
if (!SKIN_LIGHTS.includes('sssIrr') || !SKIN_LIGHTS.includes('mouthK *= uMouthLight') || !SKIN_LIGHTS.includes('* gCrease;')) console.warn('avatar: шейдер кожи не пропатчен (изменился three.js)');

/**
 * Блик прядей: от ламп из-за спины (контровые, холодный циан-белый) — слабый и в цвет
 * пряди. Белый скользящий блик GGX на тёмно-каштановых прядях читается серебристой сединой.
 */
/** Доля цвета ламп в свете на волосах (остальное — их яркость без оттенка). */
export const HAIR_LIGHT_HUE = 0.35;
const HAIR_LIGHTS = (RIM_MASK_GLSL + THREE.ShaderChunk.lights_physical_pars_fragment)
  .replace(
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
    `vec3 hairSpecK = mix( vec3( 1.0 ), 0.2 * gHairTint, lightBehind( directLight.direction.z ) );
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * hairSpecK;`,
  )
  .replace(
    'vec3 irradiance = dotNL * directLight.color;',
    // Голубые заполняющие (Fill_Left, Fill_Upper) и циан контрового Rim_Right сдвигали
    // каштановые пряди в оливковый и бирюзовый (тон 28–31° против 21° у образца цвета);
    // кожу от этого бережёт её тональная компрессия с сохранением оттенка. Волосам свет
    // ламп доходит наполовину обесцвеченным: яркость та же, оттенок остаётся за прядью
    `vec3 irradiance = dotNL * mix( vec3( dot( directLight.color, vec3( 0.2126, 0.7152, 0.0722 ) ) ), directLight.color, ${HAIR_LIGHT_HUE.toFixed(2)} );`,
  );
if (!HAIR_LIGHTS.includes('hairSpecK') || !HAIR_LIGHTS.includes('vec3( 0.2126, 0.7152, 0.0722 ) ) ), directLight.color')) console.warn('avatar: шейдер волос не пропатчен (изменился three.js)');

/**
 * Скальп-декаль (выбритые виски, линия роста волос): как кожа — контровые лампы из-за спины
 * освещают её только у силуэта (иначе Rim_Right заливает весь висок холодным циан-серым),
 * их блик почти гаснет.
 */
const CAP_LIGHTS = (RIM_MASK_GLSL + THREE.ShaderChunk.lights_physical_pars_fragment)
  .replace(
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * mix( 1.0, 0.15, lightBehind( directLight.direction.z ) );',
  )
  .replace('vec3 irradiance = dotNL * directLight.color;', 'vec3 irradiance = dotNL * directLight.color * rimMask( directLight.direction.z, geometryNormal.z );');
if (!CAP_LIGHTS.includes('rimMask( directLight.direction.z, geometryNormal.z )')) console.warn('avatar: шейдер скальпа не пропатчен (изменился three.js)');

/**
 * Щетина выбритой части. В игре декаль скальпа ложится на кожу головы, и сквозь короткие
 * тёмные волоски видна кожа; ровная заливка цветом корня даёт гладкий серый «войлочный
 * шлем». Покрытие декали = маска × (floor + (1 − floor) × точки): точки — по одной
 * случайной в ячейке UV (scale ячеек на единицу UV, radius — доля ячейки), между ними
 * кожа лишь слегка затемнена. Когда ячейка мельче пикселя, точки сводятся к их средней
 * доле — без муара на общих планах.
 */
export const CAP_STUBBLE = { scale: 420, floor: 0.32, radius: 0.3 };

/** Средняя доля покрытия скальпа щетиной (то, что видно издали). */
export function capCoverage(c: { floor: number; radius: number } = CAP_STUBBLE): number {
  const dots = Math.min(1, Math.PI * c.radius * c.radius);
  return c.floor + (1 - c.floor) * dots;
}

const STUBBLE_GLSL = `
float stubbleDots( vec2 p, float r ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 h = fract( sin( vec2( dot( i, vec2( 127.1, 311.7 ) ), dot( i, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 );
	vec2 c = 0.5 + ( h - 0.5 ) * ( 1.0 - 2.0 * r );
	float w = fwidth( p.x ) + fwidth( p.y );
	float d = 1.0 - smoothstep( r - 0.5 * w - 0.05, r + 0.5 * w + 0.05, length( f - c ) );
	return mix( d, min( 1.0, 3.14159 * r * r ), smoothstep( 0.35, 1.0, w ) );
}`;


/**
 * Брови: блик контровых ламп (холодный циан-белый, скользящий) на тонких волосках читается
 * серебристо-белым хвостом брови — как у кожи и волос, от ламп из-за спины он почти гаснет.
 * В игре брови — декаль поверх кожи и освещены как кожа под ними: контровые лампы (циан и
 * пурпур из-за спины) доходят до них только у силуэта (rimMask, как у кожи). Без маски брови на
 * лбу, обращённом к камере, получали полный холодный контровой свет, который кожа под ними не
 * получает, и читались серо-голубыми — светлее кожи на смуглых тонах.
 */
const BROW_LIGHTS = (RIM_MASK_GLSL + THREE.ShaderChunk.lights_physical_pars_fragment)
  .replace(
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * mix( 1.0, 0.1, lightBehind( directLight.direction.z ) );',
  )
  .replace('vec3 irradiance = dotNL * directLight.color;', 'vec3 irradiance = dotNL * directLight.color * rimMask( directLight.direction.z, geometryNormal.z );');
if (!BROW_LIGHTS.includes('mix( 1.0, 0.1, lightBehind') || !BROW_LIGHTS.includes('rimMask( directLight.direction.z, geometryNormal.z )'))
  console.warn('avatar: шейдер бровей не пропатчен (изменился three.js)');

/** Оттенок кожи skin.mt в линейном пространстве: multiply, при отрицательной шкале — overlay. */
const TINT_GLSL = `
#ifdef SKIN_TINT
{
	vec3 c = diffuseColor.rgb;
	vec3 t = uTint;
	vec3 ov = mix( 2.0 * c * t, 1.0 - 2.0 * ( 1.0 - c ) * ( 1.0 - t ), step( 0.5, c ) );
	vec3 tinted = uTintScale >= 0.0 ? c * t : ov;
	float f = abs( uTintScale );
	#ifdef SKIN_TINT_MASK
		float tm = texture2D( uTintMask, vMapUv ).r;
		f *= tm;
		#ifdef MOUTH_OCCLUSION
			gMouthDepth = tm;
		#endif
	#endif
	diffuseColor.rgb = mix( c, tinted, f );
}
#endif
#ifdef SKIN_EAR
{
	// уши в UV головы (одинаково у обоих полов): центры (0,205; 0,34) и (0,795; 0,34)
	vec2 eq = vec2( abs( vMapUv.x - 0.5 ) - 0.295, vMapUv.y - 0.34 ) / vec2( 0.065, 0.1 );
	gEarMask = 1.0 - smoothstep( 0.8, 1.0, length( eq ) );
}
#endif
`;

/**
 * Детальная нормаль (UV головы) и тайловые поры, по маске детализации из roughness.R.
 * SKIN_LIP_FADE: карты запечены с сомкнутыми губами, и у кромки губ нормали круто уходят
 * внутрь рта. Когда губы размыкаются (улыбка «Зубы»), эта кромка выходит наружу и ложится
 * по контуру нижней губы и в уголках бурой «крошащейся» полосой — у губ рельеф карты гасим
 * по мере открытия рта (эллипс губ в UV головы, одинаковый у обоих полов).
 */
/**
 * Складка «стенка носа — щека» в UV головы (у обоих полов, зеркально по u = 0,5). Там UV
 * резко меняют растяжение (за пару пикселей u скачет с 0,52 на 0,54), и детальный рельеф и
 * микрорельеф ложились вдоль ребра светлым «стеклянным» штрихом от угла глаза до ноздри
 * (у мужчины он был виден во всех строках лица). В самой карте нормалей складка запечена
 * острым гребнем, и он давал ту же полоску послабее. В полосе |u − 0,5| ≈ u ± half,
 * v0…v1 доля детального рельефа гаснет на fade, основной карты — на mapFade.
 */
// С mapFade 0,7 оставшаяся треть гребня всё ещё ловила Fill- и контровые лампы светлой
// линией (без карты нормалей линии нет — проверено отключением карты): гасим полностью.
export const NOSE_FOLD = { u: 0.028, half: 0.014, soft: 0.008, v0: 0.215, v1: 0.325, vSoft: 0.015, fade: 1, mapFade: 1 };

/** Доля детального рельефа (1 — полный) в точке UV головы. Как блок SKIN_NOSE в DETAIL_GLSL. */
export function noseFoldFade(u: number, v: number, f = NOSE_FOLD): number {
  const du = Math.abs(Math.abs(u - 0.5) - f.u);
  const fu = 1 - smoothstep(f.half, f.half + f.soft, du);
  const fv = smoothstep(f.v0, f.v0 + f.vSoft, v) * (1 - smoothstep(f.v1 - f.vSoft, f.v1, v));
  return 1 - f.fade * fu * fv;
}

const g4 = (x: number) => x.toFixed(4);
const NOSE_FOLD_U = g4(NOSE_FOLD.u);
const NOSE_FOLD_HALF = g4(NOSE_FOLD.half);
const NOSE_FOLD_HALF_SOFT = g4(NOSE_FOLD.half + NOSE_FOLD.soft);
const NOSE_FOLD_V0 = g4(NOSE_FOLD.v0);
const NOSE_FOLD_V0_IN = g4(NOSE_FOLD.v0 + NOSE_FOLD.vSoft);
const NOSE_FOLD_V1_IN = g4(NOSE_FOLD.v1 - NOSE_FOLD.vSoft);
const NOSE_FOLD_V1 = g4(NOSE_FOLD.v1);
const NOSE_FOLD_FADE = g4(NOSE_FOLD.fade);
const NOSE_FOLD_MAP_FADE = g4(NOSE_FOLD.mapFade);

const DETAIL_GLSL = `mapN.xy *= normalScale;
float lipFade = 1.0;
float noseFold = 1.0;
#ifdef SKIN_NOSE
{
	// складка «стенка носа — щека» (NOSE_FOLD): детальный рельеф там рисовал светлый штрих
	float du = abs( abs( vNormalMapUv.x - 0.5 ) - ${NOSE_FOLD_U} );
	float fu = 1.0 - smoothstep( ${NOSE_FOLD_HALF}, ${NOSE_FOLD_HALF_SOFT}, du );
	float fv = smoothstep( ${NOSE_FOLD_V0}, ${NOSE_FOLD_V0_IN}, vNormalMapUv.y ) * ( 1.0 - smoothstep( ${NOSE_FOLD_V1_IN}, ${NOSE_FOLD_V1}, vNormalMapUv.y ) );
	noseFold = 1.0 - ${NOSE_FOLD_FADE} * fu * fv;
	// и сама карта нормалей: складка в ней запечена острым гребнем, ловящим свет полоской
	mapN.xy *= 1.0 - ${NOSE_FOLD_MAP_FADE} * fu * fv;
}
#endif
#ifdef SKIN_LIP_FADE
{
	vec2 lq = ( vNormalMapUv - vec2( 0.498, 0.394 ) ) / vec2( 0.092, 0.043 );
	lipFade = 1.0 - 0.85 * uMouthOpen * ( 1.0 - smoothstep( 0.7, 1.0, length( lq ) ) );
	mapN.xy *= lipFade;
}
#endif
#ifdef SKIN_DETAIL
{
	vec3 dN = texture2D( uDetailNormal, vNormalMapUv ).xyz * 2.0 - 1.0;
	float dMask = 1.0;
	#ifdef USE_ROUGHNESSMAP
		dMask = texture2D( roughnessMap, vRoughnessMapUv ).r;
	#endif
	vec2 add = uDetailW * dN.xy * sign( normalScale );
	#ifdef SKIN_MICRO
		// uMicro — левая половина атласа микрорельефа отдельной текстурой с повтором (microTile)
		vec3 mN = texture2D( uMicro, vNormalMapUv * uMicroScale ).xyz * 2.0 - 1.0;
		add += mN.xy * uMicroW * dMask;
	#endif
	mapN = normalize( vec3( mapN.xy + add * lipFade * noseFold, mapN.z ) );
}
#endif`;

/**
 * Яркость прядей: рампы профиля в среднем по карточкам дают ≈ 1,5× светлее образца цвета
 * из каталога (brown_liquorice: #3e3933 против #322c28) — приводим к образцу. Чуть теплее
 * по каналам: под циановыми Fill-лампами каштановые пряди иначе выходят нейтрально-серыми.
 */
const HAIR_ALBEDO = new THREE.Vector3(0.8, 0.74, 0.7);

/**
 * Поправка цвета профиля волос по значкам редактора. Рампы профиля (корень→кончик × ID) под
 * светом редактора дают другой цвет, чем значок игры: мерло — малиновое вместо красно-бордового,
 * платина — белёсая вместо бежево-серой. Поправка сохраняет оттенок пряди: k — яркость,
 * s — насыщенность относительно яркости пряди (0 — серый той же яркости, 1 — как в рампе),
 * tint — слабый сдвиг каналов (каждый в пределах HAIR_TINT_LIMIT, яркость 1). Прежние
 * множители по каналам до ×3 подгоняли средний цвет одной причёски, а на прядях, где в рампе
 * мало красного (ID-рампа мерло с жёлто-бежевым стопом), тот же ×3 по зелёному рисовал
 * зелёные пряди и серо-оливковые длины с красными кончиками.
 * Подобрано по кадрам самого движка на трёх причёсках (длинная женская 32, каре 06, короткая
 * мужская 27): средний линейный цвет прядей против среднего цвета значка, общая яркость по
 * медиане отношений. ΔE76 по 35 цветам (двухцветные сочетания причёска × цвет исключены,
 * кадры после сведения слоёв декалей): медиана 2,6, среднее 3,8, мерло 2,8 (насыщенность C*
 * 16 против 15 у значка); без поправки — 11,6 и 12,1.
 * Жёлтые и бирюзовые (цитрус, cyberpunk_yellow, teal_ash) требуют сдвига каналов до ±15 %.
 * У мерло и яблока основную часть дают k и s (меньше насыщенности: значок бордово-коричневый,
 * а не малиновый), а сдвиг каналов не больше ±9 %: при ±15 % бежевые ID-пряди яблока
 * становились зеленее красных (тест «зелёных прядей нет»). Хуже всего омбре, у которых рампа
 * и значок расходятся по оттенку (purple_ombre ΔE 20, purple_blonde 15, mermaid_aquamarine 12):
 * значок — один средний цвет
 * двухцветной пряди, а сильнее сдвигать каналы нельзя — красные пряди станут зелёными.
 * Мерло на прямых до ключиц (женская 11, фото Зендаи) читалось вишнёво-розовым (пряди 74, 33, 32
 * против значка 56, 33, 26): насыщенность и яркость мерло снижены (s 0,514 → 0,44, k 1,351 → 1,27).
 * Сдвинуть оттенок к оранжевому каналами нельзя: светлые ID-пряди уходят от своего оттенка > 25°.
 */
export interface HairGrade {
  k: number;
  s: number;
  tint?: readonly [number, number, number];
}
export const HAIR_GRADE_LIMITS = { k: [0.3, 2.6], s: [0.25, 1.6] } as const;
export const HAIR_TINT_LIMIT = [0.85, 1.15] as const;
export const HAIR_GRADE: Readonly<Record<string, HairGrade>> = {
  brown_liquorice: { k: 0.712, s: 1.108, tint: [1.022, 0.988, 1.057] },
  blonde_platinum: { k: 0.480, s: 0.814, tint: [1.011, 0.995, 1.020] },
  red_merlot: { k: 1.27, s: 0.44, tint: [0.945, 1.025, 0.910] },
  ginger_copper: { k: 0.898, s: 0.683, tint: [0.884, 1.047, 0.878] },
  teal_ombre: { k: 0.821, s: 0.893, tint: [0.939, 1.010, 1.080] },
  black_carbon: { k: 1.011, s: 1.324, tint: [1.028, 0.985, 1.066] },
  blonde_golden: { k: 0.559, s: 0.883 },
  blonde_dishwater: { k: 0.978, s: 1.211, tint: [1.053, 0.979, 1.056] },
  blue_sapphire: { k: 1.458, s: 0.959, tint: [0.930, 1.028, 0.930] },
  brown_ombre: { k: 1.194, s: 1.490, tint: [0.987, 1.011, 0.930] },
  red_apple: { k: 1.543, s: 0.562, tint: [0.934, 1.029, 0.909] },
  gray_gunmetal: { k: 0.653, s: 1.030 },
  ginger_strawberry: { k: 1.145, s: 0.822, tint: [0.930, 1.028, 0.930] },
  teal_ash: { k: 0.392, s: 1.180, tint: [0.850, 1.028, 1.150] },
  pink_magenta: { k: 0.338, s: 0.862, tint: [0.944, 1.024, 0.930] },
  pink_rose: { k: 1.086, s: 0.657, tint: [0.940, 1.025, 0.930] },
  blue_steel: { k: 1.561, s: 0.894, tint: [0.930, 1.026, 0.951] },
  blue_red_ombre: { k: 0.982, s: 1.185, tint: [1.031, 0.987, 1.035] },
  cold_white: { k: 0.559, s: 0.859, tint: [1.006, 0.997, 1.015] },
  cyberpunk_yellow: { k: 0.391, s: 0.811, tint: [0.850, 1.030, 1.150] },
  goblin_green: { k: 0.488, s: 0.992, tint: [0.957, 1.005, 1.077] },
  liliac: { k: 0.960, s: 0.773, tint: [1.032, 0.997, 0.935] },
  mermaid_aquamarine: { k: 0.501, s: 1.600, tint: [1.048, 0.965, 1.150] },
  purple_ombre: { k: 0.892, s: 0.980, tint: [0.855, 1.062, 0.850] },
  black_salt_n_pepper: { k: 1.049, s: 0.359 },
  green_toxic: { k: 0.595, s: 0.866, tint: [1.080, 0.983, 0.934] },
  brown_medium: { k: 1.293, s: 0.838, tint: [1.008, 0.989, 1.080] },
  blue_sky: { k: 1.507, s: 1.407, tint: [0.951, 1.014, 1.005] },
  citrus_yellow: { k: 1.484, s: 1.484, tint: [1.131, 0.938, 1.150] },
  dark_purple: { k: 1.456, s: 0.995, tint: [1.080, 0.967, 1.080] },
  green_orange: { k: 0.896, s: 0.953, tint: [0.982, 1.007, 0.980] },
  liliac_ombre: { k: 2.318, s: 0.842, tint: [0.994, 1.015, 0.872] },
  phoenix_fire: { k: 0.956, s: 1.260, tint: [1.043, 0.979, 1.080] },
  purple_blonde: { k: 1.581, s: 1.441, tint: [1.131, 0.938, 1.150] },
  silver_rose: { k: 2.433, s: 1.600, tint: [1.106, 0.981, 0.880] },
};

const NEUTRAL_GRADE: HairGrade = { k: 1, s: 1 };

/** Ключ материала брови из всех полей слоя (порядок полей не важен). */
export function browKey(def: object): string {
  const d = def as Record<string, unknown>;
  return JSON.stringify(Object.keys(d).sort().map((k) => [k, d[k]]));
}

/** Поправка профиля по имени профиля или LUT скальпа (hh_cap_grad__<профиль>). */
export function hairGrade(profileOrLut: string | null | undefined): HairGrade {
  const key = (profileOrLut ?? '').replace(/^.*__/, '');
  return HAIR_GRADE[key] ?? HAIR_GRADE[profileOrLut ?? ''] ?? NEUTRAL_GRADE;
}

/** Альбедо-множитель прядей профиля: общая яркость × k × tint (насыщенность — отдельно, uSat). */
export function hairAlbedo(profileOrLut: string | null | undefined): THREE.Vector3 {
  const g = hairGrade(profileOrLut);
  const t = g.tint ?? [1, 1, 1];
  return HAIR_ALBEDO.clone().multiply(new THREE.Vector3(t[0] * g.k, t[1] * g.k, t[2] * g.k));
}

/** Цвет пряди после поправки (линейный RGB): то же, что делает шейдер (без HAIR_ALBEDO). */
export function gradeHair(c: RGB, g: HairGrade): RGB {
  const y = luma(c);
  const t = g.tint ?? [1, 1, 1];
  return [0, 1, 2].map((i) => Math.max(0, y + g.s * (c[i] - y)) * g.k * t[i]) as RGB;
}

/** GLSL: насыщенность пряди относительно её яркости (как gradeHair). */
const HAIR_SAT_GLSL = 'col = max( vec3( 0.0 ), vec3( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * ( 1.0 - uSat ) + col * uSat );';

/**
 * Глазное яблоко: доля карты нормалей радужки и сила отражения окружения. Шероховатость
 * базового слоя не зажимается: с нижней границей 0,5 и отражением окружения 0,9 карая
 * радужка (12_gradient_brown) заливалась серо-голубым матовым отражением — «слепые» глаза.
 * Искр на прожилках радужки нет и без зажима: их гасит слабая карта нормалей.
 */
export const EYE_IRIS = { normal: 0.3, envMap: 0.35 };

/**
 * Блик в глазу. С лаком (clearcoat) каждая из 15 ламп редактора давала свою точку на
 * роговице, а блик базового слоя на рельефе радужки — россыпь искр. В кадре игры у V одна
 * чистая «искра» от ключевой лампы сверху слева. Здесь прямые блики ламп на глазу почти
 * погашены (direct), а искра — одно пятно отражения в осях камеры: направление dir,
 * угловой радиус от inner (полная яркость) до outer (край), сила strength.
 */
export const EYE_CATCHLIGHT = { dir: [-0.42, 0.5, 0.76] as const, innerDeg: 5, outerDeg: 8, strength: 0.9, direct: 0.12 };

/** Яркость искры (0..1) для отражённого луча r (единичный, оси камеры). Как в шейдере глаза. */
export function catchlight(r: readonly [number, number, number], c = EYE_CATCHLIGHT): number {
  const l = Math.hypot(...c.dir);
  const d = (r[0] * c.dir[0] + r[1] * c.dir[1] + r[2] * c.dir[2]) / l;
  const lo = Math.cos((c.outerDeg * Math.PI) / 180);
  const hi = Math.cos((c.innerDeg * Math.PI) / 180);
  const t = Math.min(1, Math.max(0, (d - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/** Доля непрозрачности нижнего ряда ресниц. */
const LOWER_LASH_ALPHA = 0.55;

/**
 * Подъём нижнего ряда ресниц (м): карточки в позе привязки начинаются на ~1 мм ниже кромки
 * нижнего века, и ряд висел на коже щеки пунктиром.
 */
export const LOWER_LASH_LIFT = 0.0016;

/**
 * Пирсинг (Materials.piercing): у металла базовый цвет плашки × metalBase и отражение
 * окружения metalEnv, у пластика — plasticEnv; миниатюра узорного цвета × patternGain
 * (в ней уже запечён свет студии редактора).
 */
export const PIERCING = { metalBase: 0.75, metalEnv: 0.35, plasticEnv: 0.35, patternGain: 0.9 };

/**
 * Поправки цветов пирсинга, у которых hex плашки каталога не похож на значок цвета игры
 * (swatches/icons/Piercing_*.webp, средний цвет непрозрачных пикселей и верхние 10 % по яркости).
 * У меди, золота и серебра hex ≈ 1,1 × среднего значка, у Rose Gold hex #4e3a44 = 0,78 × среднего
 * (100, 74, 80; блик 171, 121, 113): с metalBase и слабым отражением он рисовался почти чёрным
 * сине-фиолетовым пластиком. Цвет — середина «1,1 × среднее» и «0,87 × блик», как у золота.
 * Жемчуг (Pearl) в игре — серо-серебристый градиент (среднее 163, 161, 158) с перламутровым
 * бликом, а матовый белый #c0bab3 без отражения читался мелом: немного металла и отражения. С
 * цветом #b3b0ab и отражением 0,9 он рисовался молочно-белым, светлее значка: цвет ниже среднего
 * значка (блик и отражение добавляют своё), отражение 0,5 — серо-серебристый, как значок.
 * Дерево (Wood): узор — миниатюра со светом студии, в среднем тёмная (59, 49, 40; тёплые полосы
 * 90, 57, 35, тёмные 31, 29, 25). На шариках пирсинга UV берут малый участок миниатюры, и с серым
 * множителем patternGain они выходили почти чёрными, как сталь. patternTint — множитель узора
 * по каналам (линейный): полосы коричнево-оранжевые, тёмные — тёмно-коричневые, а не серые.
 * Одного множителя мало: шарики и штанги брали тёмный участок миниатюры и выходили тёмным
 * серо-коричневым металлом (100, 80, 69), кольца при этом — как значок. patternFloor — нижняя
 * граница цвета узора (sRGB): тёмные участки поднимаются до тёмного дерева, полосы остаются
 * светлее. Серый блик пластика (отражение 0,35) приглушён: дерево матовое (в игре шероховатость 0,7).
 */
export interface PiercingFix extends Partial<Pick<PiercingMat, 'colour' | 'metalness' | 'roughness'>> {
  env?: number;
  patternTint?: readonly [number, number, number];
  patternFloor?: string;
}
export const PIERCING_FIX: Readonly<Record<string, PiercingFix>> = {
  rose_gold: { colour: '#825d5d' },
  pearl: { colour: '#8a8884', metalness: 0.3, roughness: 0.22, env: 0.5 },
  wood: { patternTint: [1.9, 1.1, 0.55], patternFloor: '#50301a', roughness: 0.65, env: 0.15 },
};

/** Покрытие ресниц (см. Materials.lashes). */
const LASH_ALPHA = `
#ifdef USE_ALPHAMAP
{
	vec2 tuv = vAlphaMapUv * vec2( textureSize( alphaMap, 0 ) );
	vec2 ddx = dFdx( tuv );
	vec2 ddy = dFdy( tuv );
	float lod = max( 0.0, 0.5 * log2( max( dot( ddx, ddx ), dot( ddy, ddy ) ) ) );
	float a = texture2D( alphaMap, vAlphaMapUv ).g;
	float sharp = saturate( ( a - 0.3 ) / max( fwidth( a ), 1e-4 ) + 0.5 );
	float soft = saturate( a * ( 1.25 + 0.5 * lod ) );
	a = mix( sharp, soft, saturate( lod - 0.5 ) );
	// нижний ряд: в игре ресницы там короткие и едва заметные (у карточки корень — v = 0)
	a *= mix( 1.0, uLowAlpha * ( 1.0 - uLowTip * smoothstep( 0.3, 0.62, vAlphaMapUv.y ) ), vLashLow );
	if ( a < 0.02 ) discard;
	diffuseColor.a *= a;
}
#endif
`;

interface SkinPatch {
  tint?: { color: THREE.Color; scale: number; mask?: THREE.Texture | null };
  detail?: { map: THREE.Texture; weight: number; micro?: THREE.Texture | null; microWeight: number; microScale: number };
  /** доля «завёрнутого» света по каналам RGB */
  scatter: THREE.Vector3;
  /** нижняя граница шероховатости */
  roughMin?: number;
  /** зубы и язык: свет гасится внутри рта (MOUTH_OCCLUSION) */
  mouth?: boolean;
  /** голова: рельеф у кромки губ гаснет, пока рот открыт (SKIN_LIP_FADE, uniform uMouthOpen) */
  lipFade?: boolean;
  /** голова: контровые лампы на ушной раковине приглушены (SKIN_EAR) */
  ears?: boolean;
  /** голова: нос матовее и с более слабым бликом (SKIN_NOSE) */
  nose?: boolean;
  /** доля нормали геометрии в диффузном свете (0 — только карта) */
  softNormal?: number;
}

/**
 * Нос мужчины в полутени выходил красно-бурым, «обгоревшим»: «завёрнутый» свет кожи
 * (SKIN_FALLOFF, больше всего красного) на стенках и крыльях носа ложится поверх и без того
 * красноватого альбедо. Внутри эллипса носа доля neutral заворота становится серой (той же
 * силы × gain): тень носа остаётся мягкой, но не краснее щёк.
 */
export const NOSE_SCATTER = { neutral: 0.65, gain: 0.9 };

/**
 * Блик в складках карты нормалей: при cos(нормаль карты, нормаль геометрии) ниже from он
 * гаснет до floor, выше to — полный. Поры и мелкий рельеф (наклон до ~20°) не затронуты.
 */
export const SKIN_CREASE = { from: 0.8, to: 0.94, floor: 0.25 };

/** Доля блика кожи в точке с данным cos между нормалью карты и геометрии (как в шейдере). */
export function creaseSpecular(cosNormal: number, c = SKIN_CREASE): number {
  const t = Math.min(1, Math.max(0, (cosNormal - c.from) / (c.to - c.from)));
  return c.floor + (1 - c.floor) * t * t * (3 - 2 * t);
}

/**
 * Нос в UV головы (одинаково у обоих полов): эллипс от переносицы до крыльев. Шероховатость
 * карты на спинке и крыльях носа почти зеркальная, и от фронтальных ламп на стенках носа
 * блестел стеклянный «мокрый» блик; в кадре игры нос матовый, как щёки: внутри эллипса
 * шероховатость не ниже 0,8, блик и его скользящая (френелевская) часть ослаблены.
 */
const NOSE_GLSL = `
#ifdef SKIN_NOSE
{
	vec2 nq = ( vMapUv - vec2( 0.5, 0.285 ) ) / vec2( 0.085, 0.09 );
	gNose = 1.0 - smoothstep( 0.6, 1.0, length( nq ) );
	roughnessFactor = max( roughnessFactor, mix( uRoughMin, 0.8, gNose ) );
	// тёплый «завёрнутый» свет на стенках и крыльях носа без примеси красного (NOSE_SCATTER)
	gScatter = mix( uScatter, vec3( dot( uScatter, vec3( 0.3333 ) ) * ${NOSE_SCATTER.gain.toFixed(2)} ), ${NOSE_SCATTER.neutral.toFixed(2)} * gNose );
	// подглазье: свет под кожей заворачивает сильнее и без лишнего красного (UNDER_EYE.scatter)
	gScatter = mix( gScatter, vec3( dot( uScatter, vec3( 0.3333 ) ) ) * ( 1.0 + uUnderEyeK.z ), uUnderEyeK.z * gEye );
}
#endif`;

/**
 * Выравнивание альбедо носа по щекам. В альбедо мужчины спинка носа на ~20 % темнее и
 * заметно краснее щёк (G/R 0,62 против 0,71), а свет кожи и тональная компрессия эту
 * разницу ещё усиливают: в кадре нос выходил красно-бурым пятном темнее лица. В игре
 * подповерхностное рассеяние и кровоток её сглаживают. Внутри эллипса носа яркость
 * подтягивается к средней по щекам (не больше NOSE_EVEN.maxLift и не в провалах ноздрей),
 * а насыщенность — только если нос краснее щёк. У женского альбедо нос уже как щёки, и
 * поправка его почти не меняет. Щёки берутся с мелкого мипа карты в двух точках UV.
 */
export const NOSE_EVEN = { amount: 1, maxLift: 1.35, chroma: 0.9 };
/**
 * Нижняя граница выравнивания носа (v в UV головы): сразу под ноздрями (v ≈ 0,322–0,334)
 * начинается верхняя губа со щетиной. Эллипс носа доходит до v 0,375, и выравнивание
 * поднимало там тёмно-серую щетину к цвету щёк (до ×1,35): над губой у мужчины выходили
 * светлые «молочные усы» (L* щетины −1 к щеке против −8 в альбедо).
 */
export const NOSE_EVEN_FLOOR = { v0: 0.334, v1: 0.344 };
const NOSE_CHEEKS_UV: readonly [number, number][] = [
  [0.38, 0.32],
  [0.62, 0.32],
];
const LUMA: RGB = [0.2126, 0.7152, 0.0722];
const luma = (c: RGB) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Цвет пикселя носа (линейный) после выравнивания по щекам ref; mask — доля эллипса носа,
 * blur — размытое альбедо вокруг пикселя (мелкий мип). Поправка — множитель по каналам,
 * посчитанный по размытому цвету: поры и веснушки остаются такими же по контрасту (с
 * попиксельным подъёмом яркости тёмные поры поднимались меньше кожи вокруг и нос
 * покрывался тёмной россыпью). Как NOSE_ALBEDO_GLSL.
 */
export function noseEven(c: RGB, ref: RGB, mask = 1, k = NOSE_EVEN, blur: RGB = c): RGB {
  const lb = Math.max(luma(blur), 1e-4);
  const lr = Math.max(luma(ref), 1e-4);
  const lift = 1 + (Math.min(Math.max(lr / lb, 1), k.maxLift) - 1) * smoothstep(0.45, 0.7, lb / lr);
  const pull = k.chroma * smoothstep(0, 0.15, (blur[0] - blur[1]) / lb - (ref[0] - ref[1]) / lr);
  const w = mask * k.amount;
  return c.map((v, i) => {
    const gain = lift * (1 + ((ref[i] / lr) / Math.max(blur[i] / lb, 1e-4) - 1) * pull);
    return v + (v * gain - v) * w;
  }) as RGB;
}

/** Доля выравнивания носа в точке UV головы (эллипс носа, без верхней губы); как NOSE_ALBEDO_GLSL. */
export function noseEvenMask(u: number, v: number): number {
  const q = Math.hypot((u - 0.5) / 0.085, (v - 0.285) / 0.09);
  return (1 - smoothstep(0.6, 1, q)) * (1 - smoothstep(NOSE_EVEN_FLOOR.v0, NOSE_EVEN_FLOOR.v1, v));
}

/**
 * Подглазья. В альбедо обоих полов под нижним веком тёмная серо-сиреневая дуга (на 20–25 %
 * темнее щеки и холоднее её), вогнутая геометрия под глазом и свет её ещё углубляют: в кадре
 * дуга выходила лиловым «синяком» (L* на 12 ниже щеки, тон на 17° краснее). В игре
 * подповерхностное рассеяние её почти стирает. В эллипсе под каждым глазом (UV головы,
 * зеркально по u = 0,5) яркость размытого альбедо подтягивается к щекам (не больше maxLift и
 * не на тёмной линии ресниц), цвет — к цвету щёк на долю chroma; поры и веснушки остаются.
 * Альбедо на уровне щеки не убирало тень самой глазницы: у мужчины под глазом оставался
 * серо-зелёный полумесяц на 10–14 L* темнее щеки (у внутреннего угла, «носослёзная борозда»).
 * Поэтому эллипс шире к носу и вниз, альбедо может стать светлее щёк до over (в игре эту тень
 * стирает подповерхностное рассеяние), а «завёрнутый» свет в эллипсе сильнее (scatter) и
 * без лишнего красного. Порог gate (доля яркости щеки) отделяет почти чёрную линию ресниц от
 * складки нижнего века: складка в альбедо вдвое темнее щеки, и с прежним порогом 0,45–0,7 её
 * не трогало — у мужчины под веком лежало пятно на 26 L* темнее щеки. После правки складка и
 * подглазье в кадре по умолчанию в пределах 6–9 L* от щеки (было 13–26).
 */
export const UNDER_EYE = { u: 0.1, v: 0.272, ru: 0.08, rv: 0.034, maxLift: 1.9, chroma: 0.8, scatter: 0.8, over: 1.1, gate: [0.28, 0.45] as [number, number] };

/** Доля поправки подглазья в точке UV головы (как блок UNDER_EYE в NOSE_ALBEDO_GLSL). */
export function underEyeMask(u: number, v: number, e = UNDER_EYE): number {
  const qx = (Math.abs(u - 0.5) - e.u) / e.ru;
  const qy = (v - e.v) / e.rv;
  return 1 - smoothstep(0.6, 1, Math.hypot(qx, qy));
}

/** Цвет пикселя подглазья (линейный) после поправки к щекам ref; blur — размытое альбедо. */
export function underEyeEven(c: RGB, ref: RGB, mask = 1, blur: RGB = c, e = UNDER_EYE): RGB {
  const lb = Math.max(luma(blur), 1e-4);
  const lr = Math.max(luma(ref), 1e-4);
  const lift = 1 + (Math.min(Math.max((lr * e.over) / lb, 1), e.maxLift) - 1) * smoothstep(e.gate[0], e.gate[1], lb / lr);
  return c.map((v, i) => {
    const gain = lift * (1 + ((ref[i] / lr) / Math.max(blur[i] / lb, 1e-4) - 1) * e.chroma);
    return v + (v * gain - v) * mask;
  }) as RGB;
}

/**
 * Кожа вокруг рта. В альбедо у кромки губ светлая бесцветная кайма (L* +1,5 к щеке при
 * насыщенности 18 против 24 у мужчины), а щетина над губой серо-голубая: в кадре у мужчины
 * над верхней губой, в уголках и под нижней губой лежала бледная серо-белая полоса — «молочные
 * усы». В эллипсе рта (UV головы) размытое альбедо светлее щёк темнеет до них (не ниже
 * minGain), а бесцветное — получает оттенок щёк на долю chroma. Губы (темнее и насыщеннее щёк)
 * и тёмная щетина (заметно темнее щёк) не меняются; поры остаются.
 */
export const MOUTH_EVEN = { v: 0.394, ru: 0.13, rv: 0.072, top: 0.334, minGain: 0.85, chroma: 0.85 };

/** Доля поправки вокруг рта в точке UV головы (как блок MOUTH_EVEN в NOSE_ALBEDO_GLSL). */
export function mouthEvenMask(u: number, v: number, m = MOUTH_EVEN): number {
  const q = Math.hypot((u - 0.498) / m.ru, (v - m.v) / m.rv);
  return (1 - smoothstep(0.7, 1, q)) * smoothstep(m.top, m.top + 0.016, v);
}

/** Цвет пикселя у рта (линейный) после поправки к щекам ref; blur — размытое альбедо. */
export function mouthEven(c: RGB, ref: RGB, mask = 1, blur: RGB = c, m = MOUTH_EVEN): RGB {
  const lb = Math.max(luma(blur), 1e-4);
  const lr = Math.max(luma(ref), 1e-4);
  const dark = Math.min(1, Math.max(m.minGain, lr / lb));
  const satB = (blur[0] - blur[2]) / lb;
  const satR = (ref[0] - ref[2]) / lr;
  const pull = m.chroma * smoothstep(0.85, 0.97, lb / lr) * smoothstep(0, 0.1, satR - satB);
  return c.map((v, i) => {
    const gain = dark * (1 + ((ref[i] / lr) / Math.max(blur[i] / lb, 1e-4) - 1) * pull);
    return v + (v * gain - v) * mask;
  }) as RGB;
}

const NOSE_ALBEDO_GLSL = `
#if defined( SKIN_NOSE ) && defined( USE_MAP )
{
	vec2 eq = vec2( abs( vMapUv.x - 0.5 ) - uUnderEye.x, vMapUv.y - uUnderEye.y ) / uUnderEye.zw;
	float em = 1.0 - smoothstep( 0.6, 1.0, length( eq ) );
	gEye = em;
	if ( em > 0.0 ) {
		vec3 ref = 0.5 * ( textureLod( map, vec2( ${NOSE_CHEEKS_UV[0].join(', ')} ), 5.0 ).rgb + textureLod( map, vec2( ${NOSE_CHEEKS_UV[1].join(', ')} ), 5.0 ).rgb );
		vec3 b = textureLod( map, vMapUv, 3.0 ).rgb;
		vec3 W = vec3( ${LUMA.join(', ')} );
		float lb = max( dot( b, W ), 1e-4 );
		float lr = max( dot( ref, W ), 1e-4 );
		float lift = 1.0 + ( clamp( lr * uUnderEyeK.w / lb, 1.0, uUnderEyeK.x ) - 1.0 ) * smoothstep( uUnderEyeG.x, uUnderEyeG.y, lb / lr );
		vec3 gain = lift * mix( vec3( 1.0 ), ( ref / lr ) / max( b / lb, vec3( 1e-4 ) ), uUnderEyeK.y );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * gain, em );
	}
}
{
	vec2 nq = ( vMapUv - vec2( 0.5, 0.285 ) ) / vec2( 0.085, 0.09 );
	float nm = ( 1.0 - smoothstep( 0.6, 1.0, length( nq ) ) ) * ( 1.0 - smoothstep( ${g4(NOSE_EVEN_FLOOR.v0)}, ${g4(NOSE_EVEN_FLOOR.v1)}, vMapUv.y ) ) * uNoseEven.x;
	if ( nm > 0.0 ) {
		vec3 ref = 0.5 * ( textureLod( map, vec2( ${NOSE_CHEEKS_UV[0].join(', ')} ), 5.0 ).rgb + textureLod( map, vec2( ${NOSE_CHEEKS_UV[1].join(', ')} ), 5.0 ).rgb );
		vec3 b = textureLod( map, vMapUv, 4.0 ).rgb;
		vec3 W = vec3( ${LUMA.join(', ')} );
		float lb = max( dot( b, W ), 1e-4 );
		float lr = max( dot( ref, W ), 1e-4 );
		float lift = 1.0 + ( clamp( lr / lb, 1.0, uNoseEven.y ) - 1.0 ) * smoothstep( 0.45, 0.7, lb / lr );
		float pull = uNoseEven.z * smoothstep( 0.0, 0.15, ( b.r - b.g ) / lb - ( ref.r - ref.g ) / lr );
		vec3 gain = lift * mix( vec3( 1.0 ), ( ref / lr ) / max( b / lb, vec3( 1e-4 ) ), pull );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * gain, nm );
	}
}
{
	// кожа вокруг рта (MOUTH_EVEN): светлая бесцветная кайма губ и серая щетина — к щекам
	vec2 mq = ( vMapUv - vec2( 0.498, ${g4(MOUTH_EVEN.v)} ) ) / vec2( ${g4(MOUTH_EVEN.ru)}, ${g4(MOUTH_EVEN.rv)} );
	float mm = ( 1.0 - smoothstep( 0.7, 1.0, length( mq ) ) ) * smoothstep( ${g4(MOUTH_EVEN.top)}, ${g4(MOUTH_EVEN.top + 0.016)}, vMapUv.y ) * uNoseEven.x;
	if ( mm > 0.0 ) {
		vec3 ref = 0.5 * ( textureLod( map, vec2( ${NOSE_CHEEKS_UV[0].join(', ')} ), 5.0 ).rgb + textureLod( map, vec2( ${NOSE_CHEEKS_UV[1].join(', ')} ), 5.0 ).rgb );
		vec3 b = textureLod( map, vMapUv, 2.0 ).rgb;
		vec3 W = vec3( ${LUMA.join(', ')} );
		float lb = max( dot( b, W ), 1e-4 );
		float lr = max( dot( ref, W ), 1e-4 );
		float dark = clamp( lr / lb, ${MOUTH_EVEN.minGain.toFixed(3)}, 1.0 );
		float pull = ${MOUTH_EVEN.chroma.toFixed(3)} * smoothstep( 0.85, 0.97, lb / lr ) * smoothstep( 0.0, 0.1, ( ref.r - ref.b ) / lr - ( b.r - b.b ) / lb );
		vec3 gain = dark * mix( vec3( 1.0 ), ( ref / lr ) / max( b / lb, vec3( 1e-4 ) ), pull );
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * gain, mm );
	}
}
#endif
`;

function patchSkin(mat: THREE.MeshPhysicalMaterial, p: SkinPatch, key: string) {
  const uniforms = {
    uTint: { value: p.tint?.color ?? new THREE.Color(1, 1, 1) },
    uTintScale: { value: p.tint?.scale ?? 0 },
    uTintMask: { value: p.tint?.mask ?? null },
    uDetailNormal: { value: p.detail?.map ?? null },
    uDetailW: { value: p.detail?.weight ?? 0 },
    uMicro: { value: p.detail?.micro ?? null },
    uMicroW: { value: p.detail?.microWeight ?? 0 },
    uMicroScale: { value: p.detail?.microScale ?? 1 },
    uScatter: { value: p.scatter },
    uRoughMin: { value: p.roughMin ?? 0.45 },
    uMouthLight: { value: 1 },
    uMouthOpen: { value: 0 },
    uHueKeep: { value: SKIN_HUE_KEEP },
    uSoftN: { value: p.softNormal ?? SKIN.softNormal },
    uNoseEven: { value: new THREE.Vector3(NOSE_EVEN.amount, NOSE_EVEN.maxLift, NOSE_EVEN.chroma) },
    uUnderEye: { value: new THREE.Vector4(UNDER_EYE.u, UNDER_EYE.v, UNDER_EYE.ru, UNDER_EYE.rv) },
    uUnderEyeK: { value: new THREE.Vector4(UNDER_EYE.maxLift, UNDER_EYE.chroma, UNDER_EYE.scatter, UNDER_EYE.over) },
    uUnderEyeG: { value: new THREE.Vector2(...UNDER_EYE.gate) },
  };
  mat.userData.skin = uniforms;
  mat.defines = { ...(mat.defines ?? {}), SKIN_SSS: '' };
  if (p.tint) mat.defines.SKIN_TINT = '';
  if (p.tint?.mask) mat.defines.SKIN_TINT_MASK = '';
  if (p.detail) mat.defines.SKIN_DETAIL = '';
  if (p.detail?.micro) mat.defines.SKIN_MICRO = '';
  if (p.mouth) mat.defines.MOUTH_OCCLUSION = '';
  if (p.lipFade) mat.defines.SKIN_LIP_FADE = '';
  if (p.ears) mat.defines.SKIN_EAR = '';
  if (p.nose) mat.defines.SKIN_NOSE = '';
  mat.onBeforeCompile = (s: Shader) => {
    Object.assign(s.uniforms, uniforms);
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uTint; uniform float uTintScale; uniform sampler2D uTintMask;
uniform sampler2D uDetailNormal; uniform float uDetailW;
uniform sampler2D uMicro; uniform float uMicroW; uniform float uMicroScale;
uniform vec3 uScatter; uniform float uRoughMin; uniform float uMouthLight; uniform float uMouthOpen; uniform float uHueKeep;
float gMouthDepth = 0.0;
float gEarMask = 0.0;
float gNose = 0.0;
float gEye = 0.0;
uniform float uSoftN; uniform vec3 uNoseEven; uniform vec4 uUnderEye; uniform vec4 uUnderEyeK; uniform vec2 uUnderEyeG;
vec3 gSoftN = vec3( 0.0, 0.0, 1.0 );
vec3 gScatter = vec3( 0.0 );
float gCrease = 1.0;`,
      )
      .replace('#include <lights_physical_pars_fragment>', SKIN_LIGHTS)
      // губы и веки в карте почти зеркальные — в кадре игры они лишь влажно блестят
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = max( roughnessFactor, uRoughMin );\ngScatter = uScatter;' + NOSE_GLSL)
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
#ifdef SKIN_NOSE
material.specularColor *= 1.0 - 0.5 * gNose;
material.specularColorBlended *= 1.0 - 0.5 * gNose;
// скользящий (френелевский) блик на боковой стенке носа — тот самый стеклянный штрих
material.specularF90 *= 1.0 - 0.7 * gNose;
#endif`,
      )
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + NOSE_ALBEDO_GLSL + TINT_GLSL)
      .replace(
        '#include <normal_fragment_maps>',
        THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', DETAIL_GLSL) +
          `
// под глазом рельеф карты (выпуклое подглазье) не смягчается: вогнутая геометрия глазницы
// иначе оставляет под веком тёмную дугу (UNDER_EYE)
gSoftN = normalize( mix( normal, nonPerturbedNormal, uSoftN * ( 1.0 - gEye ) ) );
// Глубокие складки карты нормалей (ямка над грудиной, складка у крыла носа) круто наклонены
// к геометрии и ловят скользящий блик ламп «стеклянным» штрихом — там блик гаснет
gCrease = mix( ${SKIN_CREASE.floor.toFixed(2)}, 1.0, smoothstep( ${SKIN_CREASE.from.toFixed(2)}, ${SKIN_CREASE.to.toFixed(2)}, dot( normal, nonPerturbedNormal ) ) );`,
      )
      .replace('#include <tonemapping_fragment>', SKIN_TONEMAP_GLSL);
  };
  mat.customProgramCacheKey = () => 'skin:' + key + ':' + Object.keys(mat.defines ?? {}).join(',');
}

const lin = (hex: string) => new THREE.Color(hex); // three переводит sRGB-hex в линейное рабочее пространство

/**
 * Микрорельеф кожи — атлас 2:1, шейдер берёт его левую половину. При выборке половины
 * через fract() на стыке повторов билинейный фильтр и мипы захватывали соседнюю половину
 * атласа: каждые 1/uMicroScale по u шла светлая линия (у мужчины она легла вдоль правой
 * стенки носа «стеклянным штрихом»). Левая половина сама по себе бесшовная — копируем её
 * в отдельную текстуру с обычным повтором.
 */
const microTiles = new WeakMap<THREE.Texture, Promise<THREE.Texture | null>>();
function microTile(atlas: THREE.Texture | null): Promise<THREE.Texture | null> {
  if (!atlas) return Promise.resolve(null);
  let p = microTiles.get(atlas);
  if (!p) {
    const img = atlas.image as HTMLImageElement | ImageBitmap | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    p =
      w && h && typeof createImageBitmap === 'function'
        ? createImageBitmap(img as ImageBitmapSource, 0, 0, Math.floor(w / 2), h, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }).then(
            (bmp) => {
              const t = new THREE.Texture(bmp);
              t.flipY = false;
              t.colorSpace = THREE.NoColorSpace;
              t.wrapS = t.wrapT = THREE.RepeatWrapping;
              t.anisotropy = atlas.anisotropy;
              t.needsUpdate = true;
              return t;
            },
            () => null,
          )
        : Promise.resolve(null);
    microTiles.set(atlas, p);
  }
  return p;
}

/** Цвет спада подповерхностного рассеяния кожи (falloff skin.mt) и доля «завёрнутого» света. */
export const SKIN_FALLOFF = { color: '#ffb2a5', amount: 0.6 };

/** Доля «завёрнутого» света по каналам RGB: falloff (линейный) × amount. */
export function skinScatter(f: { color: string; amount: number } = SKIN_FALLOFF): THREE.Vector3 {
  const c = lin(f.color);
  return new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(f.amount);
}

/**
 * Кожа: шероховатость = ORM.G × 1 (кожа в игре довольно матовая), F0 ≈ 0,02.
 * «Завёрнутый» свет тёплый, по цвету спада рассеяния (SKIN_FALLOFF): с нейтральным
 * заворотом (0,3 / 0,24 / 0,2) тени под голубыми Fill-лампами выходили серо-бурыми и
 * оливковыми (стенка носа, мешки под глазами). Кирпично-красного носа при этом нет: его
 * гасит выравнивание альбедо носа (NOSE_EVEN).
 */
const SKIN = { roughness: 1.0, specular: 0.5, scatter: skinScatter(), softNormal: 0.45 };

/**
 * Блик кожи по тону. Широкий блик матовой кожи (шероховатость не ниже 0,6) от голубых
 * заполняющих ламп ложится на тёмную кожу серой дымкой: на тонах 11–12 лицо выходило
 * пепельным и плоским, хотя альбедо тёплое. На светлых тонах та же дымка тонет в диффузе.
 */
export const SKIN_SPECULAR_BY_TONE: readonly [RegExp, number][] = [
  [/06_bl_dark/, 0.28],
  [/05_bl_espresso/, 0.38],
];

/**
 * Альбедо глазного яблока на тёмных тонах (11 Espresso, 12 Dark): склера той же яркости, что
 * у светлой кожи, светилась белым на тёмном лице — в игре её глушат тень века и AO уголков.
 */
export const SCLERA_BY_TONE: readonly [RegExp, number][] = [
  [/06_bl_dark/, 0.78],
  [/05_bl_espresso/, 0.86],
];

/** Множитель альбедо глазного яблока для тона кожи тела (01_ca_pale…). */
export function scleraDim(tone: string | null | undefined): number {
  for (const [re, k] of SCLERA_BY_TONE) if (tone && re.test(tone)) return k;
  return 1;
}

/** Блик кожи части наготы: по тону материала (gameMaterial, иначе суффикс имени ..._06_bl_dark). */
export function intimateSpecular(name: string, m: { gameMaterial?: string }): number {
  return skinSpecular(m.gameMaterial ?? name);
}

/** Доля блика кожи (specularIntensity) для appearance тона кожи или его ключа. */
export function skinSpecular(tone: string | null | undefined): number {
  for (const [re, k] of SKIN_SPECULAR_BY_TONE) if (tone && re.test(tone)) return k;
  return SKIN.specular;
}

/**
 * Единое соглашение карт нормалей для всего персонажа (голова, тело, руки, бельё, кибер-
 * порт): normalScale (1, 1). Выгрузка *_gl.png уже переведена из DirectX в OpenGL (G
 * инвертирован), касательные во всех glb стандартные для glTF (T вдоль +u, B вдоль −v —
 * проверено по мешам головы, тела, рук, белья и скальпа). Проверка самих карт: тест
 * интегрируемости (ротор) минимален при (±1, ±1), а не при (−1, +1), и проинтегрированный
 * при (1, 1) рельеф головы выпуклый — губы, нос, веки и завитки ушей выступают. С X = −1
 * только на голове шея светилась иначе, чем торс, и по шву шла V-образная «манишка».
 */
export const SKIN_NORMAL_SCALE: readonly [number, number] = [1, 1];

/**
 * Доля «сохранения оттенка» при тональной компрессии кожи. ACES в three сжимает каналы
 * по отдельности, и в полутени (нос, губы, крылья носа на 15–20 % темнее щёк) его «носок»
 * поднимает насыщенность: G/R носа мужчины 0,54 при 0,61 в альбедо — «обгоревший» нос.
 * Кожа смешивает обычный ACES с вариантом, где кривая применяется к яркости, а цвет
 * масштабируется целиком (оттенок альбедо сохраняется при любой освещённости).
 * С долей 0,85 тени теряли и тот тёплый тон, который им даёт «носок» ACES, — насыщенность
 * теней падала до 0,2, и они выглядели серыми и грязными; красноту носа теперь снимает
 * выравнивание альбедо (NOSE_EVEN), поэтому сохранение оттенка лишь половинное.
 */
export const SKIN_HUE_KEEP = 0.5;

type RGB = [number, number, number];
const rrtOdt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const mul3 = (m: number[][], c: RGB): RGB => [0, 1, 2].map((i) => m[i][0] * c[0] + m[i][1] * c[1] + m[i][2] * c[2]) as RGB;
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

/** ACESFilmicToneMapping three.js (линейный цвет → [0, 1]), для тестов и проверки констант. */
export function acesFilmicRGB(c: RGB, exposure = 1): RGB {
  const v = mul3(ACES_IN, c.map((x) => (x * exposure) / 0.6) as RGB).map(rrtOdt) as RGB;
  return mul3(ACES_OUT, v).map((x) => Math.min(1, Math.max(0, x))) as RGB;
}

/**
 * Тональная компрессия кожи с сохранением оттенка: обычный ACES смешивается с
 * «яркостным» (кривая по яркости, цвет масштабируется целиком). Та же формула, что в
 * шейдере (SKIN_TONEMAP_GLSL).
 */
export function skinToneMap(rgb: RGB, keep = SKIN_HUE_KEEP): RGB {
  const aces = acesFilmicRGB(rgb);
  const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const s = l > 1e-5 ? acesFilmicRGB([l, l, l])[1] / l : 0;
  return [0, 1, 2].map((i) => aces[i] + (Math.min(1, rgb[i] * s) - aces[i]) * keep) as RGB;
}

const SKIN_TONEMAP_GLSL = `
#if defined( TONE_MAPPING )
{
	vec3 cIn = gl_FragColor.rgb;
	vec3 cAces = toneMapping( cIn );
	float lIn = dot( cIn, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 cHue = lIn > 1e-5 ? min( cIn * ( toneMapping( vec3( lIn ) ).g / lIn ), vec3( 1.0 ) ) : vec3( 0.0 );
	gl_FragColor.rgb = mix( cAces, cHue, uHueKeep );
}
#endif`;

/**
 * Uniform patch of a material's shader: kept on userData so texturesOf (and the memory trim
 * that relies on it) sees the textures it samples. A texture missing there is freed while the
 * material still draws with it, and its closed ImageBitmap uploads as an empty black texture.
 */
function keepUniforms(mat: THREE.Material, u: Record<string, { value: unknown }>) {
  mat.userData.uniforms = u;
}

/** Фабрика материалов одного движка: всё кешируется по ключу, текстуры — через AssetStore. */
/** Все текстуры материала: карты three и текстуры в uniform патчей шейдера (userData). */
export function texturesOf(m: THREE.Material, out = new Set<THREE.Texture>()): Set<THREE.Texture> {
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 3) return;
    if ((v as THREE.Texture).isTexture) {
      out.add(v as THREE.Texture);
      return;
    }
    if (Array.isArray(v)) return;
    for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
  };
  for (const v of Object.values(m)) if (v && typeof v === 'object' && (v as THREE.Texture).isTexture) out.add(v as THREE.Texture);
  visit(m.userData, 0);
  const u = (m as THREE.ShaderMaterial).uniforms;
  if (u) visit(u, 0);
  return out;
}

/**
 * Брови: альбедо тёмной брови не светлее этой доли альбедо кожи под ней. Без предела на
 * тонах 11–12 кожа темнее альбедо брови, и брови пропадали или серели.
 */
export const BROW_DARK_MAX = 0.35;

/** NormalAlpha бровей игры (eyebrows_grad__default.mi): рельеф волосков поверх кожи. */
export const BROW_NORMAL_ALPHA = 0.4;

/** Шероховатость волосков бровей (кожа под ними — по своей карте). */
export const BROW_ROUGHNESS = 0.92;

/** Градиент цвета слоя (брови): R диффуза — позиция в градиенте × интенсивность. */
export interface DecalGradient {
  gradient?: string;
  gradientIntensity?: number;
}

/** Кожа головы для вида: альбедо типа кожи и оттенок тона (общий ключ кожи и слоёв лица). */
interface HeadSpec {
  albedo: string;
  tintColor: string;
  tintScale: number;
  specular: number;
  key: string;
}
function headSpec(g: SkinGender, skinApp: string | null, skinType: string): HeadSpec {
  const toneKey = skinApp && g.skinTones[skinApp] ? skinApp : Object.keys(g.skinTones)[0];
  const tone = g.skinTones[toneKey];
  const entry = tone.byskinType[skinType] ?? Object.values(tone.byskinType)[0];
  const albedo = entry?.albedo ?? g.skinTypes[skinType]?.albedo ?? Object.values(g.skinTypes)[0].albedo;
  const tintColor = entry?.tintColor ?? tone.tintColor;
  const tintScale = entry?.tintScale ?? tone.tintScale;
  const specular = skinSpecular(toneKey);
  return { albedo, tintColor, tintScale, specular, key: `${albedo}:${tintColor}:${tintScale}:${specular}` };
}

/**
 * Знак зелёного канала нормали слоя лица в экранном базисе касательных (UV glTF без
 * переворота): карты выгружены в OpenGL-зелёный (face/decals.py), как у кожи.
 */
export const DECAL_NORMAL_Y = -1;

/**
 * Сила рельефа слоя. Диффузный свет кожи считается по нормали, наполовину смешанной с
 * нормалью геометрии (SKIN.softNormal), и рельеф шрамов в нём почти пропадал; рельеф слоя
 * добавляется и к этой мягкой нормали (gDecalRelief), а здесь — с запасом.
 */
export const DECAL_RELIEF = 1.5;

/**
 * Тату (лицо и тело): текстуры игры — чернила, нарисованные по телесному фону (≈ #a7856d там,
 * где чернил нет), либо сплошной цвет чернил; DiffuseColor по тону кожи лишь приглушает этот
 * фон под тон. Наложение «как есть» (смешивание к RGB текстуры с DiffuseAlpha 0,6–0,7) рисовало
 * серо-бежевую полупрозрачную плёнку, на тёмной коже — светлее кожи («негатив»). Чернила
 * умножают кожу: множитель — отношение текстуры к фону (не больше 1: тату никогда не светлит
 * кожу), доля — альфа текстуры × DiffuseAlpha × gain.
 * Тёмные чернила — нейтральный множитель: у блэкворка игры краска тёмно-бирюзовая (#1e2e29),
 * а отношение к тёплому фону по каналам — (0,03; 0,12; 0,15), и кожа под ним уходила в
 * оливково-бирюзовый. В игре такой слой (lerp к почти чёрному цвету) только затемняет кожу,
 * поэтому оттенок множителя гаснет по мере его темноты (яркость множителя ниже neutral[0] —
 * чистая яркость, выше neutral[1] — свой оттенок, как у красных и зелёных чернил).
 * Тёмные чернила кроют плотно: в игре слой — lerp к цвету чернил (#1e2e29 — почти чёрный), а
 * умножение на отношение к фону (≈ 0,1) с долей 0,87 пропускало 13 % кожи, и блэкворк на груди
 * читался полупрозрачной коричневой футболкой (чернила лишь на 40 % темнее кожи). Для тёмных
 * (по мере погашенного оттенка) яркость множителя возводится в степень dark.power (одним
 * множителем на все каналы, оттенок кожи сохраняется), а доля — × dark.gain:
 * сплошная заливка становится почти чёрной, цветные чернила не меняются.
 */
export const TATTOO_INK = { paper: '#a7856d', gain: 1.45, neutral: [0.05, 0.4] as const, dark: { power: 1.4, gain: 1.2 } };

/** Слой — тату (по текстуре игры): head_tattoo__…, tattoo_body__… */
export function isInkDecal(diffuse: string | null | undefined): boolean {
  return !!diffuse && /(^|\/)(head_)?tattoo_/.test(diffuse);
}

/** Множитель кожи под тату (линейные RGB 0…1): как шейдер (DECAL_INK, intimateDecal). */
export function inkFactor(tex: RGB, alpha: number, diffuseAlpha: number, ink = TATTOO_INK): RGB {
  const paper = new THREE.Color(ink.paper);
  const a = Math.min(1, Math.max(0, alpha * diffuseAlpha * ink.gain));
  const f = [paper.r, paper.g, paper.b].map((p, i) => Math.min(1, tex[i] / p)) as RGB;
  const y = luma(f);
  const keep = smoothstep(ink.neutral[0], ink.neutral[1], y);
  const dark = 1 - keep;
  const k = 1 + (ink.dark.power - 1) * dark;
  const aD = Math.min(1, a * (1 + (ink.dark.gain - 1) * dark));
  const m = f.map((v) => y + (v - y) * keep) as RGB;
  // степень — по яркости, одним множителем на все каналы: оттенок кожи под тату не меняется
  const dim = Math.pow(Math.max(1e-6, luma(m)), k - 1);
  return m.map((v) => 1 + (v * dim - 1) * aD) as RGB;
}

const INK_GLSL = (texRgb: string, texA: string, alphaU: string) => `vec3 inkF = min( ${texRgb} / uInkPaper, vec3( 1.0 ) );
	float inkDark = 0.0;
	{
		float inkY = dot( inkF, vec3( 0.2126, 0.7152, 0.0722 ) );
		float inkKeep = smoothstep( ${g4(TATTOO_INK.neutral[0])}, ${g4(TATTOO_INK.neutral[1])}, inkY );
		inkF = mix( vec3( inkY ), inkF, inkKeep );
		inkDark = 1.0 - inkKeep;
		inkF *= pow( max( dot( inkF, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-6 ), ${g4(TATTOO_INK.dark.power - 1)} * inkDark );
	}
	float inkA = saturate( ${texA} * ${alphaU} * ${TATTOO_INK.gain.toFixed(2)} * ( 1.0 + ${g4(TATTOO_INK.dark.gain - 1)} * inkDark ) );`;

/** Сдвиг мипа шума SecondaryMask с мелким повтором (зерно пудры у макияжа глаз). */
export const DECAL_GRAIN_BIAS = 3;
/** Повтор SecondaryMask, начиная с которого шум считается зерном, а не формой слоя. */
export const DECAL_GRAIN_SCALE = 8;
/** Шероховатость слоя без своей карты: серая текстура движка по умолчанию. */
export const DECAL_DEFAULT_ROUGHNESS = 0.5;
/**
 * Отражение окружения на металле слоя (кибер-импланты, золотая помада): у кожи envMapIntensity
 * 0,12, и хром с картой металличности игры оставался матово-серым.
 */
export const DECAL_METAL_ENV = 6;

/** Какие текстуры слоя загружены (faceDecal). */
export interface DecalTexSet {
  map: boolean;
  grad: boolean;
  sec: boolean;
  nrm: boolean;
  nAlpha: boolean;
  rough: boolean;
  metal: boolean;
  sec2: boolean;
}

/** Ветки шейдера слоя лица по параметрам .mi и загруженным текстурам. */
export function decalDefines(d: FaceDecalMat & DecalGradient, t: DecalTexSet): Record<string, string> {
  const defs: Record<string, string> = { FACE_DECAL: '' };
  if (t.map) defs.DECAL_MAP = '';
  if (t.grad) defs.DECAL_GRADIENT = '';
  else if (t.map && isInkDecal(d.diffuse)) defs.DECAL_INK = '';
  if (t.sec && (d.secondaryMaskInfluence ?? 0) > 0) {
    defs.DECAL_SEC = '';
    if ((d.secondaryMaskUVScale ?? 1) >= DECAL_GRAIN_SCALE) defs.DECAL_SEC_GRAIN = '';
  }
  if (t.nrm && (d.normalAlpha ?? 0) > 0) defs.DECAL_NORMAL = '';
  if (t.nAlpha) defs.DECAL_NALPHA_TEX = '';
  const rm = (d.roughnessMetalnessAlpha ?? 0) > 0;
  if (rm && t.rough) defs.DECAL_ROUGH = '';
  else if (rm) defs.DECAL_ROUGH_CONST = '';
  // металл: карта игры (кибер-импланты) или константа сдвига (золотая помада, metalnessBias 1)
  if (rm && t.metal) defs.DECAL_METAL = defs.DECAL_METAL_MAP = '';
  else if (rm && (d.metalnessBias ?? 0) > 0) defs.DECAL_METAL = '';
  if (t.sec2 && (d.secondaryDiffuseAlphaIntensity ?? 0) > 0) defs.DECAL_DOUBLE = '';
  return defs;
}

/** Дефайны слоя, каждый из которых добавляет программе текстуру. */
const DECAL_SAMPLER_DEFINES = ['DECAL_MAP', 'DECAL_GRADIENT', 'DECAL_SEC', 'DECAL_NORMAL', 'DECAL_NALPHA_TEX', 'DECAL_ROUGH', 'DECAL_METAL_MAP', 'DECAL_DOUBLE'];
/**
 * Сколько текстур слоя помещается в программу. Кожа головы под слоем уже берёт 12 из 16
 * текстурных блоков, гарантированных почти любой видеокартой: морфы, кости, альбедо, нормаль,
 * шероховатость, детальная нормаль, окружение, DFG и четыре карты теней. Кибер-импланту нужно
 * пять (цвет, нормаль, альфа нормали, шероховатость, металл): семнадцатый блок three не
 * привязывает, и импланты рисовались матовой серой заливкой без металла.
 */
export const DECAL_SAMPLER_BUDGET = 4;

/** Число текстур слоя в программе по его дефайнам. */
export function decalSamplers(defs: Record<string, string>): number {
  return DECAL_SAMPLER_DEFINES.filter((k) => k in defs).length;
}

const DECAL_PARS_GLSL = `
uniform vec3 uInkPaper;
varying vec2 vDecalUv;
uniform sampler2D uDecalMap; uniform vec3 uDecalColor; uniform float uDecalAlpha;
uniform sampler2D uDecalSec; uniform vec2 uDecalSecP;
uniform sampler2D uDecalNormal; uniform float uDecalNormalA; uniform sampler2D uDecalNormalATex;
uniform sampler2D uDecalRough; uniform sampler2D uDecalMetal; uniform vec4 uDecalRM; uniform float uDecalMetalScale;
uniform sampler2D uDecalSec2; uniform float uDecalSec2Int; uniform vec3 uDecalSec2Color;
uniform sampler2D uDecalGrad; uniform float uDecalGradInt; uniform float uDecalMetalEnv;
float gDecalA = 0.0;
float gDecalShape = 0.0;
float gDecalSec = 1.0;
vec3 gDecalRelief = vec3( 0.0 );
// кожа под слоем и цвет слоя с его долей: свои доли цвета, шероховатости и металла
// пересчитываются к общей доле покрытия gDecalA перед светом (DECAL_COMPOSE_GLSL)
vec3 gDecalC0 = vec3( 0.0 );
vec3 gDecalCS = vec3( 0.0 );
float gDecalCA = 0.0;
float gDecalR0 = 1.0;
float gDecalM0 = 0.0;
// базис касательных по UV слоя из производных (как getTangentFrame three.js; у меша слоя
// касательные — кожи, для её карты нормалей)
mat3 decalTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
	vec3 q0 = dFdx( eye_pos.xyz );
	vec3 q1 = dFdy( eye_pos.xyz );
	vec2 st0 = dFdx( uv.st );
	vec2 st1 = dFdy( uv.st );
	vec3 N = normalize( surf_norm );
	vec3 q1perp = cross( q1, N );
	vec3 q0perp = cross( N, q0 );
	vec3 T = q1perp * st0.x + q0perp * st1.x;
	vec3 B = q1perp * st0.y + q0perp * st1.y;
	float det = max( dot( T, T ), dot( B, B ) );
	float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
	return mat3( T * scale, B * scale, N );
}`;

/** Альбедо: цвет слоя (diffuse.rgb × DiffuseColor, второй слой mesh_decal_double_diffuse) по его альфе. */
const DECAL_ALBEDO_GLSL = `
{
	gDecalC0 = diffuseColor.rgb;
	vec4 dTex = vec4( 1.0 );
#ifdef DECAL_MAP
	dTex = texture2D( uDecalMap, vDecalUv );
#endif
#ifdef DECAL_SEC
	// SecondaryMask: тёмное в маске — там слой (шрамы, шум туши). Мелкий повтор шума (×30 у
	// макияжа глаз) — зерно пудры мельче пикселя: без сдвига мипа он ложился на веко
	// правильной сеткой, как ткань (DECAL_SEC_GRAIN)
	#ifdef DECAL_SEC_GRAIN
		gDecalSec = mix( 1.0, 1.0 - texture2D( uDecalSec, vDecalUv * uDecalSecP.x, ${DECAL_GRAIN_BIAS.toFixed(1)} ).r, uDecalSecP.y );
	#else
		gDecalSec = mix( 1.0, 1.0 - texture2D( uDecalSec, vDecalUv * uDecalSecP.x ).r, uDecalSecP.y );
	#endif
#endif
	gDecalShape = dTex.a * gDecalSec;
	float aS = saturate( dTex.a * uDecalAlpha * gDecalSec );
#ifdef DECAL_GRADIENT
	// брови (mesh_decal_double_diffuse с GradientMap): цвет волоска — градиент по R диффуза
	vec3 cS = texture2D( uDecalGrad, vec2( dTex.r, 0.5 ) ).rgb * uDecalGradInt;
	{
		// Тёмные волоски (каштан, чёрный, мерло) темнее кожи на любом тоне: на тонах 11–12
		// альбедо такой брови светлее кожи, и бровь читалась серой полосой. Светлые (блонд,
		// пастель) остаются своим цветом
		float darkHair = 1.0 - smoothstep( 0.05, 0.16, dot( cS, vec3( 0.2126, 0.7152, 0.0722 ) ) );
		cS = mix( cS, min( cS, diffuseColor.rgb * ${g4(BROW_DARK_MAX)} ), darkHair );
	}
#elif defined( DECAL_INK )
	// тату: чернила умножают кожу (TATTOO_INK), а не заменяют её цветом текстуры
	${INK_GLSL('dTex.rgb', 'dTex.a * gDecalSec', 'uDecalAlpha')}
	vec3 cS = diffuseColor.rgb * inkF;
	aS = inkA;
#else
	vec3 cS = dTex.rgb * uDecalColor;
#endif
#ifdef DECAL_DOUBLE
	float aB = saturate( texture2D( uDecalSec2, vDecalUv ).r * uDecalSec2Int );
	float aT = aS + aB * ( 1.0 - aS );
	// второй слой (тень под волосками) только затемняет кожу: SecondaryDiffuseColor игры
	// (#3e312a) светлее тёмных тонов кожи и выбеливал их
	vec3 c2 = min( uDecalSec2Color, diffuseColor.rgb );
	cS = ( cS * aS + c2 * aB * ( 1.0 - aS ) ) / max( aT, 1e-4 );
	aS = aT;
	gDecalShape = max( gDecalShape, aB );
#endif
	diffuseColor.rgb = mix( diffuseColor.rgb, cS, aS );
	gDecalCS = cS;
	gDecalCA = aS;
	gDecalA = aS;
}`;

/**
 * Шероховатость и металличность слоя (RoughnessMetalnessAlpha) — помада с блеском, металл
 * импланта. Шероховатость слоя в игре заменяет шероховатость кожи из карты; у нас кожа головы
 * зажата снизу (roughMin 0,6: голые губы в карте 0,36). Слой глаже кожи карты (глянцевая
 * помада 0,25) берётся как есть, слой матовее неё — сдвигом на ту же разницу от нашей кожи
 * (матовая помада 0,5 против губ 0,36 → 0,74): иначе «матовая» блестела бы сильнее голых губ.
 * Без своей карты шероховатости у слоя — серая текстура движка по умолчанию (0,5).
 */
const DECAL_RM_GLSL = `
	gDecalR0 = roughnessFactor;
	gDecalM0 = metalnessFactor;
#ifdef DECAL_GRADIENT
	// волоски бровей матовые: блик кожи на рельефе волосков серебрил бровь
	roughnessFactor = mix( roughnessFactor, ${g4(BROW_ROUGHNESS)}, saturate( gDecalA ) );
#endif
#if defined( DECAL_ROUGH ) || defined( DECAL_ROUGH_CONST )
{
	float rmA = saturate( uDecalRM.x * gDecalShape );
	#ifdef DECAL_ROUGH
		float rT = saturate( texture2D( uDecalRough, vDecalUv ).r * uDecalRM.y + uDecalRM.z );
	#else
		float rT = saturate( ${DECAL_DEFAULT_ROUGHNESS.toFixed(2)} * uDecalRM.y + uDecalRM.z );
	#endif
	float rMap = roughness;
	#ifdef USE_ROUGHNESSMAP
		rMap *= texture2D( roughnessMap, vRoughnessMapUv ).g;
	#endif
	float rDec = rT < rMap ? rT : saturate( roughnessFactor + rT - rMap );
	roughnessFactor = mix( roughnessFactor, rDec, rmA );
	gDecalA = max( gDecalA, rmA );
}
#endif
#ifdef DECAL_METAL
{
	float mA = saturate( uDecalRM.x * gDecalShape );
	#ifdef DECAL_METAL_MAP
		float mT = texture2D( uDecalMetal, vDecalUv ).r * uDecalMetalScale + uDecalRM.w;
	#else
		float mT = uDecalRM.w;
	#endif
	metalnessFactor = mix( metalnessFactor, saturate( mT ), mA );
	gDecalA = max( gDecalA, mA );
}
#endif`;

/**
 * Слой рисует кожу ещё раз и смешивается с кадром по общей доле покрытия gDecalA. Цвет,
 * шероховатость и металл слоя смешаны с кожей по своим долям (≤ gDecalA) — перед светом они
 * делятся на gDecalA, и итог в кадре = кожа + (слой − кожа) × своя доля. Раньше доля
 * применялась дважды (в альбедо и в смешивании с кадром): тушь с альфой 0,55 ложилась на 30 %,
 * чёрная подводка выходила полупрозрачной серо-бурой, брови — пепельными и бледными.
 */
const DECAL_COMPOSE_GLSL = `
{
	float invA = 1.0 / max( gDecalA, 1e-4 );
	diffuseColor.rgb = mix( gDecalC0, gDecalCS, saturate( gDecalCA * invA ) );
	roughnessFactor = saturate( gDecalR0 + ( roughnessFactor - gDecalR0 ) * min( invA, 1e4 ) );
	metalnessFactor = saturate( gDecalM0 + ( metalnessFactor - gDecalM0 ) * min( invA, 1e4 ) );
}
#include <lights_physical_fragment>`;

/**
 * Рельеф слоя добавляется к рельефу кожи (поры остаются, шрам выступает поверх). Доля
 * покрытия от рельефа — только там, где карта слоя действительно наклонена.
 */
const DECAL_NORMAL_GLSL = `
#ifdef DECAL_NORMAL
{
	vec3 dn = texture2D( uDecalNormal, vDecalUv ).xyz * 2.0 - 1.0;
	dn.y *= ${DECAL_NORMAL_Y.toFixed(1)};
	dn.z = sqrt( saturate( 1.0 - dot( dn.xy, dn.xy ) ) );
	mat3 dtbn = decalTangentFrame( - vViewPosition, nonPerturbedNormal, vDecalUv );
	#ifdef DECAL_NALPHA_TEX
		float na = uDecalNormalA * texture2D( uDecalNormalATex, vDecalUv ).r * gDecalSec;
	#else
		float na = uDecalNormalA * gDecalShape;
	#endif
	na = saturate( na );
	vec3 dN = normalize( dtbn * dn );
	gDecalRelief = na * ${DECAL_RELIEF.toFixed(2)} * ( dN - nonPerturbedNormal );
	normal = normalize( normal + gDecalRelief );
	gDecalA = max( gDecalA, na * saturate( length( dn.xy ) * 6.0 ) );
}
#endif`;

export class Materials {
  private cache = new Map<string, Promise<THREE.Material>>();
  /** готовые материалы и когда их последний раз просили (для вытеснения) */
  private ready = new Map<string, THREE.Material>();
  private used = new Map<string, number>();
  private tick = 0;
  private env: THREE.Texture | null = null;
  private envReady: Promise<void>;
  /**
   * env — окружение для бликов глаз, зубов и ногтей. Его сборка (PMREM) занимает ~0,8 с
   * главного потока, поэтому движок отдаёт её промисом и строит в простое, пока грузятся
   * файлы V; материалы ждут его перед созданием (envMap входит в программу шейдера).
   */
  constructor(
    private store: AssetStore,
    env: THREE.Texture | null | Promise<THREE.Texture | null>,
  ) {
    this.envReady = Promise.resolve(env).then(
      (t) => void (this.env = t),
      () => void (this.env = null),
    );
  }

  /** Сколько программ шейдеров нужно материалам в кеше (для проверки производительности). */
  get size() {
    return this.cache.size;
  }

  /** Сколько материалов ещё собирается (их текстуры чистке памяти трогать нельзя). */
  get pending() {
    return this.cache.size - this.ready.size;
  }

  private once<T extends THREE.Material>(key: string, make: () => Promise<T>): Promise<T> {
    this.used.set(key, ++this.tick);
    let p = this.cache.get(key);
    if (!p) {
      p = this.envReady.then(make);
      const mine = p;
      p.then(
        (m) => {
          if (this.cache.get(key) === mine) this.ready.set(key, m);
        },
        () => {
          if (this.cache.get(key) === mine) this.cache.delete(key);
        },
      );
      this.cache.set(key, p);
    }
    return p as Promise<T>;
  }

  /**
   * Освободить материалы, которых нет ни на одном живом меше и которые не входят в keep
   * последних запрошенных. Возвращает текстуры оставшихся материалов: их AssetStore не трогает.
   */
  trim(live: Set<THREE.Material> = new Set(), keep = 32): Set<THREE.Texture> {
    const recent = new Set([...this.used].sort((a, b) => b[1] - a[1]).slice(0, keep).map(([k]) => k));
    for (const [key, m] of this.ready) {
      if (live.has(m) || recent.has(key)) continue;
      this.ready.delete(key);
      this.cache.delete(key);
      this.used.delete(key);
      m.dispose();
    }
    const tex = new Set<THREE.Texture>();
    for (const m of this.ready.values()) texturesOf(m, tex);
    for (const m of live) texturesOf(m, tex);
    return tex;
  }

  // ---------------------------------------------------------------- кожа
  /** Голова: альбедо типа кожи (d01…d05) + оттенок тона во время отрисовки. */
  headSkin(g: SkinGender, gender: string, skinApp: string | null, skinType: string): Promise<THREE.MeshPhysicalMaterial> {
    const spec = headSpec(g, skinApp, skinType);
    return this.once(`head:${gender}:${spec.key}`, () => this.makeHeadSkin(g, spec, 'head_skin'));
  }

  /** decal: слой лица — без тайлового микрорельефа (у слоя свои текстуры, а блоков текстур в шейдере 16). */
  private async makeHeadSkin(g: SkinGender, spec: HeadSpec, name: string, decal = false): Promise<THREE.MeshPhysicalMaterial> {
    const { albedo, tintColor, tintScale } = spec;
    {
      const [map, normal, rough, detail, micro] = await Promise.all([
        this.store.texture(albedo, 'color'),
        this.store.texture(g.maps.normal, 'data'),
        this.store.texture(g.maps.roughness, 'data'),
        this.store.maybeTexture(g.maps.detailNormal, 'data'),
        decal ? Promise.resolve(null) : this.store.maybeTexture(g.maps.microDetailNormal, 'data', { repeat: true }).then(microTile),
      ]);
      const mat = new THREE.MeshPhysicalMaterial({
        name,
        map,
        normalMap: normal,
        normalScale: new THREE.Vector2(...SKIN_NORMAL_SCALE),
        roughnessMap: rough,
        roughness: SKIN.roughness,
        metalness: 0,
        specularIntensity: spec.specular,
        envMap: this.env,
        envMapIntensity: 0.12,
      });
      patchSkin(
        mat,
        {
          tint: { color: lin(tintColor), scale: tintScale },
          detail: detail
            ? { map: detail, weight: g.params.DetailNormalInfluence * 0.6, micro, microWeight: g.params.MicroDetailInfluence * 0.35, microScale: g.params.MicroDetailUVScale01 * 1.4 }
            : undefined,
          scatter: SKIN.scatter.clone(),
          // губы и веки в карте почти зеркальные; в кадре игры губы матово-мягкие
          roughMin: 0.6,
          lipFade: true,
          ears: true,
          nose: true,
        },
        'head',
      );
      return mat;
    }
  }

  /**
   * Слой лица (mesh_decal игры). Декаль в игре меняет G-буфер кожи до освещения: альбедо
   * заменяется цветом декали по её альфе, нормаль и шероховатость — по своим долям, а свет
   * (подповерхностное рассеяние, тон, тональная компрессия) остаётся светом кожи. Здесь меш
   * слоя рисует кожу головы ещё раз — тот же материал по UV головы (атрибут headUv, см.
   * transferHeadAttrs) — с подменой альбедо/нормали/шероховатости, и смешивается с кадром по
   * своей доле покрытия: где декали нет, кадр не меняется, тёмная тушь темна на любой коже,
   * а белая подводка светлая. Шрамы (почти только карта нормалей) меняют рельеф, а не цвет.
   */
  faceDecal(g: SkinGender, gender: string, skinApp: string | null, skinType: string, name: string, d: FaceDecalMat & DecalGradient): Promise<THREE.MeshPhysicalMaterial> {
    const spec = headSpec(g, skinApp, skinType);
    return this.once(`decal:${gender}:${spec.key}:${name}`, async () => {
      const tex = (rel: string | undefined, kind: 'color' | 'data', repeat = false) => (rel ? this.store.texture(rel, kind, { repeat }) : Promise.resolve(null));
      const [mat, map, sec, nrm, nAlpha, rough, metal, sec2, grad] = await Promise.all([
        this.makeHeadSkin(g, spec, 'face_decal', true),
        // с градиентом R диффуза — индекс в градиент, а не цвет
        tex(d.diffuse, d.gradient ? 'data' : 'color'),
        tex(d.secondaryMask, 'data', true),
        tex(d.normal, 'data'),
        tex(d.normalAlphaTex, 'data'),
        tex(d.roughness, 'data'),
        tex(d.metalness, 'data'),
        tex(d.secondaryDiffuseAlpha, 'data'),
        d.gradient ? this.store.texture(d.gradient, 'color', { lut: true }) : Promise.resolve(null),
      ]);
      mat.transparent = true;
      mat.depthWrite = false;
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -4;
      const u = {
        uDecalMap: { value: map },
        uDecalColor: { value: lin(d.diffuseColor ?? '#ffffff') },
        uDecalAlpha: { value: d.diffuseAlpha ?? 0 },
        uDecalSec: { value: sec },
        uDecalSecP: { value: new THREE.Vector2(d.secondaryMaskUVScale ?? 1, d.secondaryMaskInfluence ?? 0) },
        uDecalNormal: { value: nrm },
        uDecalNormalA: { value: d.normalAlpha ?? 0 },
        uDecalNormalATex: { value: nAlpha },
        uDecalRough: { value: rough },
        uDecalMetal: { value: metal },
        uDecalRM: { value: new THREE.Vector4(d.roughnessMetalnessAlpha ?? 0, d.roughnessScale ?? 1, d.roughnessBias ?? 0, d.metalnessBias ?? 0) },
        uDecalMetalScale: { value: d.metalnessScale ?? 1 },
        uDecalSec2: { value: sec2 },
        uDecalSec2Int: { value: d.secondaryDiffuseAlphaIntensity ?? 0 },
        uDecalSec2Color: { value: lin(d.secondaryDiffuseColor ?? '#ffffff') },
        uDecalGrad: { value: grad },
        uDecalGradInt: { value: d.gradientIntensity ?? 1 },
        uDecalMetalEnv: { value: DECAL_METAL_ENV },
        uInkPaper: { value: lin(TATTOO_INK.paper) },
      };
      // текстуры кожи (их держит материал головы) и слоя: чистка памяти видит их через userData
      mat.userData.uniforms = u;
      const defs = decalDefines(d, { map: !!map, grad: !!grad, sec: !!sec, nrm: !!nrm, nAlpha: !!nAlpha, rough: !!rough, metal: !!metal, sec2: !!sec2 });
      mat.defines = { ...(mat.defines ?? {}), ...defs };
      // Слою не хватает текстурных блоков: под ним не рисуем детальную нормаль кожи — слой с
      // таким числом карт (импланты) закрывает кожу сам, а неполное покрытие у его края узкое
      if (decalSamplers(defs) > DECAL_SAMPLER_BUDGET) {
        delete mat.defines.SKIN_DETAIL;
        delete mat.defines.SKIN_MICRO;
      }
      const skinCompile = mat.onBeforeCompile;
      mat.onBeforeCompile = (s: Shader, r: THREE.WebGLRenderer) => {
        skinCompile.call(mat, s, r);
        Object.assign(s.uniforms, u);
        s.vertexShader = s.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec2 headUv;\nvarying vec2 vDecalUv;')
          .replace(
            '#include <uv_vertex>',
            `#include <uv_vertex>
vDecalUv = uv;
// кожа головы — по её UV (ближайшая вершина головы)
#ifdef USE_MAP
	vMapUv = headUv;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = headUv;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = headUv;
#endif`,
          );
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\n' + DECAL_PARS_GLSL)
          .replace('#include <color_fragment>', DECAL_ALBEDO_GLSL + '\n#include <color_fragment>')
          .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + DECAL_RM_GLSL)
          .replace('gSoftN = normalize(', DECAL_NORMAL_GLSL + '\ngSoftN = normalize(')
          .replace('gCrease = mix(', 'gSoftN = normalize( gSoftN + gDecalRelief );\ngCrease = mix(')
          .replace('#include <lights_physical_fragment>', DECAL_COMPOSE_GLSL)
          .replace(
            '#include <lights_fragment_end>',
            // металл слоя отражает окружение (у кожи оно почти погашено, envMapIntensity 0,12)
            '#if defined( DECAL_METAL ) && defined( USE_ENVMAP )\nradiance *= mix( 1.0, uDecalMetalEnv, metalnessFactor );\n#endif\n#include <lights_fragment_end>',
          )
          .replace('#include <opaque_fragment>', 'diffuseColor.a = gDecalA;\n#include <opaque_fragment>');
        if (import.meta.env.DEV && !s.fragmentShader.includes('gDecalCS, saturate( gDecalCA * invA )')) console.warn('avatar: шейдер слоя лица не пропатчен');
      };
      const skinKey = mat.customProgramCacheKey.bind(mat);
      mat.customProgramCacheKey = () => skinKey() + ':decal:' + Object.keys(defs).join(',');
      return mat;
    });
  }

  /** Пирсинг: цвет плашки редактора (многослойные материалы игры не переносятся), металл или пластик. */
  /**
   * Пирсинг. Узорные цвета (мрамор, радужная плёнка, сталь с рябью, дерево) — многослойные
   * материалы игры: один hex плашки красил их ровным белёсым пластиком, поэтому на них
   * ложится миниатюра цвета из редактора (pattern). Металл — с цветом плашки, но отражение
   * окружения слабее: при 0,9 серебро, сталь и жемчуг выходили одинаково белыми.
   */
  piercing(raw: PiercingMat): Promise<THREE.MeshStandardMaterial> {
    const fix: PiercingFix = (raw.name && PIERCING_FIX[raw.name]) || {};
    const p = { ...raw, ...fix };
    const tint = fix.patternTint ?? [PIERCING.patternGain, PIERCING.patternGain, PIERCING.patternGain];
    return this.once(`piercing:${p.colour}:${p.metalness}:${p.roughness}:${p.pattern ?? ''}:${fix.env ?? ''}:${tint.join(',')}:${fix.patternFloor ?? ''}`, async () => {
      const map = p.pattern ? await this.store.maybeTexture(p.pattern, 'color', { repeat: true }).catch(() => null) : null;
      const metal = p.metalness > 0.5;
      const mat = new THREE.MeshStandardMaterial({
        name: 'piercing',
        color: map ? new THREE.Color(...tint) : lin(p.colour).multiplyScalar(metal ? PIERCING.metalBase : 1),
        map,
        metalness: p.metalness,
        roughness: p.roughness,
        envMap: this.env,
        envMapIntensity: fix.env ?? (metal ? PIERCING.metalEnv : PIERCING.plasticEnv),
      });
      if (map && fix.patternFloor) {
        const floor = { value: lin(fix.patternFloor) };
        mat.userData.patternFloor = floor.value;
        mat.onBeforeCompile = (sh: Shader) => {
          sh.uniforms.uPatternFloor = floor;
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uPatternFloor;')
            .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb = max( diffuseColor.rgb, uPatternFloor );');
        };
        mat.customProgramCacheKey = () => 'piercing_floor';
      }
      return mat;
    });
  }

  /** Тело и руки: альбедо уже запечено под тон (textures.<g>_<part>.albedoByTone). */
  bodySkin(set: BodyTexSet, part: string, tone: string): Promise<THREE.MeshPhysicalMaterial> {
    const albedo = set.albedoByTone[tone] ?? Object.values(set.albedoByTone)[0];
    return this.once(`body:${part}:${albedo}:${skinSpecular(tone)}`, async () => {
      const [map, normal, orm] = await Promise.all([
        this.store.texture(albedo, 'color'),
        this.store.texture(set.normal, 'data'),
        this.store.texture(set.orm, 'data'),
      ]);
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'body_skin_' + part,
        map,
        normalMap: normal,
        // то же соглашение, что у головы: иначе по шву шеи свет ложится по-разному
        normalScale: new THREE.Vector2(...SKIN_NORMAL_SCALE),
        roughnessMap: orm,
        roughness: SKIN.roughness,
        metalness: 0,
        specularIntensity: skinSpecular(tone),
        envMap: this.env,
        envMapIntensity: 0.12,
      });
      // Как у головы: с более гладкой кожей ключицы и грудь блестят белыми полосами
      patchSkin(mat, { scatter: SKIN.scatter.clone(), roughMin: 0.6 }, 'body');
      return mat;
    });
  }

  // ---------------------------------------------------------------- глаза, ресницы, брови, зубы
  eyeball(e: EyeEntry, tone?: string | null): Promise<THREE.MeshPhysicalMaterial> {
    const m = e.eyeball.maps;
    const dim = scleraDim(tone);
    return this.once(`eye:${m.albedo}:${dim}`, async () => {
      // UV глазных яблок разнесены по тайлам (центр левого глаза — u = 1,5): нужен повтор
      const [map, normal, orm] = await Promise.all([
        this.store.texture(m.albedo, 'color', { repeat: true }),
        this.store.maybeTexture(m.normal, 'data', { repeat: true }),
        this.store.maybeTexture(m.orm, 'data', { repeat: true }),
      ]);
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'eyeball',
        map,
        // склера в игре не «светится»: кадр тёмный, глаз затенён веком
        color: new THREE.Color(0.78, 0.76, 0.75).multiplyScalar(dim),
        normalMap: normal,
        // Рельеф радужки под роговицей: с полной картой и гладким базовым слоем каждая
        // её прожилка ловила свои лампы — бело-розовые искры по всей радужке. Чёткий
        // одиночный блик даёт гладкий лак (роговица) по нормали геометрии.
        normalScale: new THREE.Vector2(EYE_IRIS.normal, EYE_IRIS.normal),
        roughnessMap: orm,
        metalnessMap: e.eyeball.shader === 'multilayered_baked' ? orm : null,
        roughness: 1,
        metalness: e.eyeball.shader === 'multilayered_baked' ? 1 : 0,
        envMap: this.env,
        envMapIntensity: EYE_IRIS.envMap,
      });
      const c = EYE_CATCHLIGHT;
      const dir = new THREE.Vector3(...c.dir).normalize();
      const u = {
        uCatchDir: { value: dir },
        uCatchCos: { value: new THREE.Vector2(Math.cos((c.outerDeg * Math.PI) / 180), Math.cos((c.innerDeg * Math.PI) / 180)) },
        uCatch: { value: c.strength },
        uDirectSpec: { value: c.direct },
      };
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uCatchDir; uniform vec2 uCatchCos; uniform float uCatch; uniform float uDirectSpec;')
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
{
	// блики ламп на рельефе радужки — почти погашены; вместо них одна искра ключевой лампы
	reflectedLight.directSpecular *= uDirectSpec;
	vec3 rv = reflect( normalize( -vViewPosition ), normalize( nonPerturbedNormal ) );
	float k = smoothstep( uCatchCos.x, uCatchCos.y, dot( rv, uCatchDir ) );
	reflectedLight.directSpecular += vec3( uCatch * k );
}`,
          );
      };
      mat.customProgramCacheKey = () => 'eyeball_catch';
      return mat;
    });
  }

  /**
   * eye_shadow_wetness игры — не блестящая плёнка, а затенение у кромки век: цвет кадра
   * умножается на mix(1, ShadowColor, A^Exponent · Intensity). Неосвещённый слой с
   * умножающим смешиванием, поэтому на закрытом веке нет ни бликов, ни «подводки».
   */
  eyeShadow(e: EyeEntry): Promise<THREE.Material | null> {
    const w = e.eye_wetness;
    if (!w) return Promise.resolve(null);
    const rel = w.maps.maskRGBA ?? w.maps.maskA;
    return this.once(`eyeshadow:${rel}:${w.params.ShadowColor}:${w.params.Intensity}:${w.params.Exponent}`, async () => {
      const mask = await this.store.texture(rel, 'data');
      const mat = new THREE.MeshBasicMaterial({
        name: 'eye_shadow',
        map: mask,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.DstColorFactor,
        blendDst: THREE.ZeroFactor,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
      const u = {
        uShadowColor: { value: lin(w.params.ShadowColor) },
        uShadowInt: { value: w.params.Intensity },
        uShadowExp: { value: w.params.Exponent },
        // 1 — глаза открыты; при моргании слой гаснет, иначе он ложится пятном на закрытое веко
        uEyesOpen: { value: 1 },
      };
      mat.userData.eyeShadow = u;
      // В файле с RGBA маска — в альфе; отдельная маска A — в серых каналах
      const ch = w.maps.maskRGBA ? 'a' : 'g';
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uShadowColor; uniform float uShadowInt; uniform float uShadowExp; uniform float uEyesOpen;')
          .replace(
            '#include <map_fragment>',
            `{
	float m = pow( texture2D( map, vMapUv ).${ch}, uShadowExp ) * uShadowInt * uEyesOpen;
	diffuseColor = vec4( mix( vec3( 1.0 ), uShadowColor, saturate( m ) ), 1.0 );
}`,
          );
      };
      mat.customProgramCacheKey = () => 'eye_shadow:' + ch;
      return mat;
    });
  }

  /** Влажная слёзная кромка нижнего века (канал B маски): только слабый блик, без диффузного цвета. */
  eyeTearline(e: EyeEntry): Promise<THREE.Material | null> {
    const w = e.eye_wetness;
    if (!w?.maps.maskRGBA) return Promise.resolve(null);
    const rel = w.maps.maskRGBA;
    const k = Math.min(1, 0.15 * (w.params.WetnessStrength ?? 4));
    return this.once(`tearline:${rel}:${k}`, async () => {
      const mask = await this.store.texture(rel, 'data');
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'eye_tearline',
        color: 0x000000,
        alphaMap: mask,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        roughness: 0.3,
        metalness: 0,
        specularIntensity: 0.6,
        envMap: this.env,
        envMapIntensity: 0.2,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -3,
      });
      const u = { uWet: { value: k } };
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uWet;')
          .replace('#include <alphamap_fragment>', 'diffuseColor.a *= saturate( texture2D( alphaMap, vAlphaMapUv ).b * 4.0 ) * uWet;');
      };
      mat.customProgramCacheKey = () => 'eye_tearline';
      return mat;
    });
  }

  /**
   * Ресницы: одна тонкая ресница на карточку 32×128, на экране она уже пикселя. Обычный
   * alphaTest на мипах рвёт её в точки, поэтому покрытие считаем сами: вблизи альфа
   * заостряется по fwidth, издали мип-альфа усиливается по уровню мипа (как в «Anti-aliased
   * Alpha Test», B. Golus) и идёт прямо в alpha-to-coverage MSAA.
   */
  lashes(e: LashEntry, doubled: boolean): Promise<THREE.MeshLambertMaterial> {
    const c = e.eyelashes.suggestedColor.product;
    return this.once('lash:' + e.eyelashes.maps.alpha + c, async () => {
      const alpha = await this.store.texture(e.eyelashes.maps.alpha, 'data', { repeat: true });
      // Только диффузный свет: у PBR-материала тонкие ресницы ловят скользящий блик
      // контровых ламп (Rim_Top, Rim_Right) и читаются серебристыми при любом цвете
      const mat = new THREE.MeshLambertMaterial({
        name: 'lashes',
        color: lin(c).multiplyScalar(0.45),
        alphaMap: alpha,
        alphaToCoverage: true,
        side: doubled ? THREE.DoubleSide : THREE.FrontSide,
      });
      // одна ресница на высокую карточку (32×128) — нижний ряд ещё и укорачиваем
      const img = alpha.image as { width?: number; height?: number } | undefined;
      const single = !!img?.width && !!img.height && img.height >= img.width * 2;
      mat.onBeforeCompile = (s: Shader) => {
        s.uniforms.uLowAlpha = { value: LOWER_LASH_ALPHA };
        s.uniforms.uLowTip = { value: single ? 1 : 0 };
        s.vertexShader = s.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float lashLow;\nvarying float vLashLow;')
          // нижний ряд в позе привязки висит под кромкой века: поднимаем корни к веку (оси привязки, Y вверх)
          .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLashLow = lashLow;\ntransformed.y += lashLow * ${LOWER_LASH_LIFT.toFixed(4)};`);
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uLowAlpha; uniform float uLowTip;\nvarying float vLashLow;')
          .replace('#include <alphamap_fragment>', LASH_ALPHA)
          // Свет на ресницах — только яркостью: тёмные волоски под голубыми Fill-лампами
          // иначе отливают бирюзой (у мужчины ресницы выглядели зелёно-синими)
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
{
	vec3 W = vec3( 0.2126, 0.7152, 0.0722 );
	float lit = dot( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, W );
	float base = max( dot( diffuseColor.rgb, W ), 1e-4 );
	reflectedLight.directDiffuse = diffuseColor.rgb * ( lit / base );
	reflectedLight.indirectDiffuse = vec3( 0.0 );
}`,
          );
      };
      if (import.meta.env.DEV && !THREE.ShaderLib.lambert.fragmentShader.includes('#include <alphamap_fragment>')) console.warn('avatar: шейдер ресниц не пропатчен');
      mat.customProgramCacheKey = () => 'lashes:' + (single ? 1 : 0);
      return mat;
    });
  }

  /**
   * Брови как слой кожи (faceDecal), как в игре: декаль заменяет альбедо кожи и освещается
   * светом кожи (с её подповерхностным рассеянием и тоном). Альбедо — градиент цвета по R
   * диффуза (× интенсивность), под волосками — второй слой SecondaryDiffuseColor. Тёмные брови
   * темнее кожи на любом тоне и тёплые, как цвет волос, а не серые.
   * Ключ кеша — все поля слоя: каждое из них идёт в шейдер, и две брови, отличные хоть одним
   * полем (интенсивность градиента, подложка, нормаль стиля), не должны делить материал.
   */
  browDecal(g: SkinGender, gender: string, skinApp: string | null, skinType: string, style: BrowStyle, colour: BrowColour, gradient: string): Promise<THREE.MeshPhysicalMaterial> {
    const def: FaceDecalMat & DecalGradient = {
      type: 'decal',
      diffuse: style.diffuseRGBA,
      diffuseAlpha: colour.DiffuseAlpha,
      gradient,
      gradientIntensity: colour.GradientMapIntensity,
      secondaryDiffuseAlpha: style.secondaryAlpha,
      secondaryDiffuseAlphaIntensity: colour.SecondaryDiffuseAlphaIntensity,
      secondaryDiffuseColor: colour.SecondaryDiffuseColor,
      normal: style.normal,
      normalAlpha: BROW_NORMAL_ALPHA,
    };
    return this.faceDecal(g, gender, skinApp, skinType, `brow:${browKey(def)}`, def);
  }

  /** Зубы, дёсны и язык: натуральные — skin.mt с затемнением глубины рта по маске. */
  teeth(t: TeethEntry): Promise<THREE.MeshPhysicalMaterial> {
    const s = t.teeth_gums_tongue;
    return this.once('teeth:' + s.maps.albedo, async () => {
      const [map, normal, orm, mask] = await Promise.all([
        this.store.texture(s.maps.albedo, 'color'),
        this.store.maybeTexture(s.maps.normal, 'data'),
        this.store.maybeTexture(s.maps.orm, 'data'),
        this.store.maybeTexture(s.maps.tintColorMask, 'data'),
      ]);
      const ml = s.shader === 'multilayered_baked';
      // Натуральные зубы — влажная эмаль без лака: без clearcoat и почти без отражения
      // окружения, иначе боковые зубы в тени выглядят серебряными
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'teeth',
        map,
        normalMap: normal,
        roughnessMap: orm,
        metalnessMap: ml ? orm : null,
        roughness: ml ? 1 : 0.85,
        metalness: ml ? 1 : 0,
        clearcoat: ml ? 0.3 : 0,
        clearcoatRoughness: 0.35,
        specularIntensity: ml ? 1 : 0.6,
        envMap: this.env,
        envMapIntensity: ml ? 0.35 : 0.1,
      });
      // Свет внутри рта гасится и у металлических коронок (без маски глубины — только по губам)
      patchSkin(
        mat,
        {
          tint: !ml && s.params.TintColor && mask ? { color: lin(s.params.TintColor), scale: s.params.TintScale ?? 0, mask } : undefined,
          // эмаль не кожа: тёплый заворот кожи окрасил бы боковые зубы в розовый
          scatter: new THREE.Vector3(0.3, 0.24, 0.2),
          roughMin: ml ? 0.2 : 0.45,
          mouth: true,
        },
        ml ? 'teeth_ml' : 'teeth',
      );
      return mat;
    });
  }

  // ---------------------------------------------------------------- нагота (body/intimate.json)
  /**
   * Кожа частей наготы (соски, «нет гениталий», пенис, вагина у мужского тела): как тело —
   * альбедо уже под тон, ORM.G — шероховатость, блик тона (skinSpecular). Части лежат на коже
   * тела вплотную, поэтому чуть сдвинуты к камере по глубине. С бликом светлой кожи (0,5 против
   * 0,28 у тела на тоне 12) основание пениса на тёмной коже читалось серой трапецией.
   */
  intimateSkin(name: string, m: IntimateSkinMat): Promise<THREE.MeshPhysicalMaterial> {
    return this.once('intimate_skin:' + name, async () => {
      const [map, normal, orm] = await Promise.all([
        this.store.texture(m.albedo, 'color'),
        this.store.maybeTexture(m.normal, 'data'),
        this.store.maybeTexture(m.orm, 'data'),
      ]);
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'intimate_skin',
        map,
        normalMap: normal,
        normalScale: new THREE.Vector2(...SKIN_NORMAL_SCALE),
        roughnessMap: orm,
        roughness: SKIN.roughness,
        metalness: 0,
        specularIntensity: intimateSpecular(name, m),
        envMap: this.env,
        envMapIntensity: 0.12,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
      patchSkin(mat, { scatter: SKIN.scatter.clone(), roughMin: 0.6 }, 'body');
      return mat;
    });
  }

  /**
   * Декаль наготы (тату, шрамы, лобковые волосы; mesh_decal.mt): цвет = DiffuseColor ×
   * diffuse.rgb, прозрачность = diffuse.a × DiffuseAlpha, рельеф — карта нормалей с долей
   * NormalAlpha. pubic — тёмный ореол текстуры волос (щетина) гасится по яркости
   * (pubicHaloAlpha): с цветными волосами он читается серым пятном.
   */
  intimateDecal(name: string, m: IntimateDecalMat, pubic: boolean): Promise<THREE.Material> {
    if (!pubic && isInkDecal(m.diffuse)) return this.bodyInk(name, m);
    return this.once('intimate_decal:' + name, async () => {
      const [map, normal, rough] = await Promise.all([
        this.store.texture(m.diffuse, 'color'),
        this.store.maybeTexture(m.normal, 'data'),
        this.store.maybeTexture(m.roughness, 'data'),
      ]);
      const na = THREE.MathUtils.clamp(m.normalAlpha ?? 0, 0, 1);
      const mat = new THREE.MeshStandardMaterial({
        name: 'intimate_decal',
        map,
        color: lin(m.diffuseColor ?? '#ffffff'),
        opacity: THREE.MathUtils.clamp(m.diffuseAlpha ?? 1, 0, 1),
        transparent: true,
        depthWrite: false,
        normalMap: na > 0 ? normal : null,
        normalScale: new THREE.Vector2(na, na),
        // шрамы: маска шероховатости игры (RoughnessMetalnessAlpha) — рубец чуть глаже кожи
        roughness: rough ? 0.55 : 0.75,
        metalness: 0,
        envMap: this.env,
        envMapIntensity: 0.1,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
      if (pubic) {
        mat.onBeforeCompile = (s: Shader) => {
          s.fragmentShader = s.fragmentShader
            .replace('#include <lights_physical_pars_fragment>', BROW_LIGHTS)
            .replace(
              '#include <map_fragment>',
              `#include <map_fragment>
#ifdef USE_MAP
{
	float lm = saturate( dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / 0.05 );
	diffuseColor.a *= lm * lm * ( 3.0 - 2.0 * lm );
}
#endif`,
            );
        };
        mat.customProgramCacheKey = () => 'intimate_pubic';
      }
      return mat;
    });
  }

  /**
   * Тату тела: множитель поверх уже освещённой кожи (MultiplyBlending), как DECAL_INK у лица —
   * чернила темнее кожи на любом тоне и никогда её не светлят; свет и тени кожи сохраняются.
   */
  private bodyInk(name: string, m: IntimateDecalMat): Promise<THREE.Material> {
    return this.once('intimate_decal:' + name, async () => {
      const map = await this.store.texture(m.diffuse, 'color');
      const mat = new THREE.MeshBasicMaterial({
        name: 'body_ink',
        map,
        transparent: true,
        blending: THREE.MultiplyBlending,
        premultipliedAlpha: true,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
      const u = { uInkPaper: { value: lin(TATTOO_INK.paper) }, uInkAlpha: { value: m.diffuseAlpha ?? 1 } };
      keepUniforms(mat, u);
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uInkPaper; uniform float uInkAlpha;').replace(
          '#include <map_fragment>',
          `#include <map_fragment>
{
	${INK_GLSL('diffuseColor.rgb', 'diffuseColor.a', 'uInkAlpha')}
	diffuseColor = vec4( mix( vec3( 1.0 ), inkF, inkA ), 1.0 );
}`,
        );
      };
      mat.customProgramCacheKey = () => 'body_ink';
      return mat;
    });
  }

  /** Освободить материал наготы (строка переключена, меш скрыт надолго). */
  releaseIntimate(name: string) {
    for (const key of ['intimate_skin:' + name, 'intimate_decal:' + name]) {
      const p = this.cache.get(key);
      if (!p) continue;
      this.cache.delete(key);
      this.ready.delete(key);
      this.used.delete(key);
      p.then((m) => m.dispose()).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- руки
  nails(n: NailMat): Promise<THREE.MeshPhysicalMaterial> {
    return this.once('nail:' + n.albedo, async () => {
      const [map, orm, normal] = await Promise.all([
        this.store.texture(n.albedo, 'color'),
        this.store.maybeTexture(n.orm, 'data'),
        this.store.maybeTexture(n.normal, 'data'),
      ]);
      return new THREE.MeshPhysicalMaterial({
        name: 'nails',
        map,
        roughnessMap: orm,
        metalnessMap: orm,
        normalMap: normal,
        roughness: 1,
        metalness: 1,
        clearcoat: 0.6,
        clearcoatRoughness: 0.15,
        envMap: this.env,
        envMapIntensity: 0.8,
      });
    });
  }

  /** Металл импланта (персональный разъём на руке): ORM — шероховатость и металличность. */
  standard(name: string, base: string, orm: string | undefined, normal: string | undefined): Promise<THREE.MeshStandardMaterial> {
    return this.once('std:' + base, async () => {
      const [map, o, n] = await Promise.all([
        this.store.texture(base, 'color'),
        this.store.maybeTexture(orm, 'data'),
        this.store.maybeTexture(normal, 'data'),
      ]);
      return new THREE.MeshStandardMaterial({
        name,
        map,
        roughnessMap: o,
        metalnessMap: o,
        normalMap: n,
        normalScale: new THREE.Vector2(...SKIN_NORMAL_SCALE),
        roughness: 1,
        metalness: o ? 1 : 0,
        envMap: this.env,
        envMapIntensity: 0.3,
      });
    });
  }

  // ---------------------------------------------------------------- волосы
  /**
   * Карточки прядей: цвет = рампа «корень→кончик»(Strand_Gradient) × рампа ID(Strand_ID)
   * в линейном пространстве, альфа — Strand_Alpha. pass 'core' — непрозрачная сердцевина
   * с записью глубины, 'fringe' — мягкая кромка поверх без записи глубины.
   */
  hairCards(hm: HairManifest, m: HairMaterial, pass: 'core' | 'fringe', doubleSided: boolean): Promise<THREE.MeshStandardMaterial> {
    const set = hm.cardSets[m.cardSet ?? ''];
    const prof = hm.profiles[m.profile ?? ''];
    if (!set || !prof) return Promise.reject(new Error('hair: нет набора карточек или профиля'));
    const alphaRel = set.alpha ? hm.textures[set.alpha]?.file : null;
    const sparse = m.cardSet === 'beard01' || m.cardSet === 'short01';
    return this.once(`hair:${m.cardSet}:${m.profile}:${pass}:${doubleSided}`, async () => {
      const [packed, ramp, alpha] = await Promise.all([
        this.store.texture(set.packed, 'data', { repeat: true }),
        this.store.texture(prof.ramp, 'color', { lut: true }),
        this.store.maybeTexture(alphaRel, 'data', { repeat: true }),
      ]);
      // Волосы в кадре игры матовые: блик слабый, широкий и окрашен в цвет пряди
      // (у белого GGX с F0 0,04 тёмно-каштановые пряди выглядят седыми)
      const rough = THREE.MathUtils.clamp((m.roughnessBias ?? 0.15) + 0.5 * (m.roughnessScale ?? 0.15) + 0.45, 0.65, 0.8);
      const core = pass === 'core';
      const mat = new THREE.MeshStandardMaterial({
        name: 'hair_' + pass,
        map: packed,
        alphaMap: alpha,
        roughness: rough,
        metalness: 0,
        side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        transparent: !core,
        alphaTest: alpha ? (core ? (sparse ? 0.4 : 0.5) : 0.02) : 0,
        depthWrite: core,
        envMap: this.env,
        envMapIntensity: 0.04,
      });
      const u = {
        uRamp: { value: ramp },
        uShadow: { value: m.shadowStrength ?? 0.5 },
        uIdGain: { value: 1.0 },
        uSpec: { value: 0.4 },
        uAlbedo: { value: hairAlbedo(m.profile) },
        uSat: { value: hairGrade(m.profile).s },
      };
      keepUniforms(mat, u);
      mat.userData.hairProfile = m.profile;
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uRamp; uniform float uShadow; uniform float uIdGain; uniform float uSpec; uniform vec3 uAlbedo; uniform float uSat;\nvec3 gHairTint = vec3( 1.0 );')
          .replace('#include <lights_physical_pars_fragment>', HAIR_LIGHTS)
          .replace(
            '#include <lights_physical_fragment>',
            `#include <lights_physical_fragment>
material.specularColor = 0.04 * uSpec * mix( vec3( 1.0 ), gHairTint, 0.75 );
material.specularColorBlended = material.specularColor;
material.specularF90 = 0.5 * uSpec;`,
          )
          .replace(
            '#include <map_fragment>',
            `{
	vec4 pk = texture2D( map, vMapUv );
	vec3 rt = texture2D( uRamp, vec2( pk.r, 0.25 ) ).rgb;
	vec3 id = texture2D( uRamp, vec2( pk.g, 0.75 ) ).rgb;
	vec3 col = rt * min( id * uIdGain, vec3( 1.0 ) );
	${HAIR_SAT_GLSL}
	col *= mix( 1.0 - 0.5 * uShadow, 1.0, smoothstep( 0.0, 0.3, pk.r ) );
	diffuseColor.rgb *= col * uAlbedo;
	gHairTint = col / max( max( col.r, max( col.g, col.b ) ), 1e-3 );
}`,
          );
      };
      mat.customProgramCacheKey = () => 'hair_cards';
      return mat;
    });
  }

  /** Скальп-декаль: цвет = LUT(серый diffuse) × diffuseColor, альфа = маска × маска импланта. */
  hairCap(hm: HairManifest, m: HairMaterial): Promise<THREE.MeshStandardMaterial> {
    const tex = (k: string | null | undefined) => (k ? hm.textures[k]?.file ?? null : null);
    return this.once(`cap:${m.diffuse}:${m.mask}:${m.gradientLUT}:${m.secondaryMask}:${m.diffuseColor}`, async () => {
      const [diff, mask, lut, sec] = await Promise.all([
        this.store.maybeTexture(tex(m.diffuse), 'data'),
        this.store.maybeTexture(tex(m.mask), 'data'),
        this.store.texture(tex(m.gradientLUT) ?? '', 'color', { lut: true }),
        this.store.maybeTexture(tex(m.secondaryMask), 'data', { repeat: true }),
      ]);
      const mat = new THREE.MeshStandardMaterial({
        name: 'hair_cap',
        map: diff,
        alphaMap: mask,
        transparent: true,
        depthWrite: false,
        alphaTest: 0.004,
        roughness: 1,
        metalness: 0,
        opacity: m.diffuseAlpha ?? 1,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
      const u = {
        uLut: { value: lut },
        uDiffConst: { value: m.diffuseConstant ?? 0.5176 },
        uCapColor: { value: lin(m.diffuseColor ?? '#ffffff') },
        uSec: { value: sec },
        uSecInfl: { value: sec ? m.secondaryMaskInfluence ?? 0 : 0 },
        uSecScale: { value: m.secondaryMaskUVScale ?? 1 },
        uAlbedo: { value: hairAlbedo(m.gradientLUT) },
        uSat: { value: hairGrade(m.gradientLUT).s },
        uStubble: { value: new THREE.Vector3(CAP_STUBBLE.scale, CAP_STUBBLE.floor, CAP_STUBBLE.radius) },
      };
      keepUniforms(mat, u);
      mat.userData.hairProfile = (m.gradientLUT ?? '').replace(/^.*__/, '');
      const hasDiff = !!diff;
      const hasSec = !!sec && !!mask;
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
uniform sampler2D uLut; uniform float uDiffConst; uniform vec3 uCapColor; uniform sampler2D uSec; uniform float uSecInfl; uniform float uSecScale;
uniform vec3 uAlbedo; uniform float uSat; uniform vec3 uStubble;
${STUBBLE_GLSL}`,
          )
          .replace('#include <lights_physical_pars_fragment>', CAP_LIGHTS)
          .replace(
            '#include <map_fragment>',
            `{
	float g = ${hasDiff ? 'texture2D( map, vMapUv ).r' : 'uDiffConst'};
	vec3 col = texture2D( uLut, vec2( g, 0.5 ) ).rgb * uCapColor;
	${HAIR_SAT_GLSL}
	diffuseColor.rgb = col * uAlbedo;
}`,
          )
          .replace(
            '#include <alphamap_fragment>',
            `#include <alphamap_fragment>
${hasSec ? 'diffuseColor.a *= mix( 1.0, texture2D( uSec, vAlphaMapUv * uSecScale ).g, uSecInfl );' : ''}
#if defined( USE_ALPHAMAP )
diffuseColor.a *= mix( uStubble.y, 1.0, stubbleDots( vAlphaMapUv * uStubble.x, uStubble.z ) );
#elif defined( USE_MAP )
diffuseColor.a *= mix( uStubble.y, 1.0, stubbleDots( vMapUv * uStubble.x, uStubble.z ) );
#endif`,
          );
      };
      mat.customProgramCacheKey = () => `hair_cap:${hasDiff}:${hasSec}`;
      return mat;
    });
  }

  /**
   * Тень щетины под бородой (mesh_decal игры): тёмный цвет DiffuseColor с альфой маски ×
   * DiffuseAlpha. Матовая, без бликов: это тон кожи под волосками, а не блестящий слой.
   * Блика нет совсем (specularIntensity 0): у слоя roughness 1 и F0 0,04, но на силуэте щеки
   * френель доводил отражение почти до 1, и красная контровая лампа рисовала вдоль края лица у
   * уха тонкий малиновый шов (борода 06, кадр анфас).
   */
  beardShadow(hm: HairManifest, m: HairMaterial): Promise<THREE.MeshPhysicalMaterial> {
    const mask = m.mask ? hm.textures[m.mask]?.file ?? null : null;
    return this.once(`beardShadow:${mask}:${m.diffuseColor}:${m.diffuseAlpha}`, async () => {
      const alpha = await this.store.texture(mask ?? '', 'data');
      return new THREE.MeshPhysicalMaterial({
        name: 'beard_shadow',
        specularIntensity: 0,
        color: lin(m.diffuseColor ?? '#22150a'),
        alphaMap: alpha,
        opacity: m.diffuseAlpha ?? 1,
        transparent: true,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
    });
  }

  /**
   * Аксессуар причёски (резинки, заколки, палочки, бусины). Материалы игры запечены в альбедо
   * и ORM (multilayered: сталь / ткань / золото по маскам слоёв): палочки пучка 084 лежат в
   * золотом слое атласа. С одним средним цветом атласа (fallbackColor, серый металл) они
   * выходили белыми металлическими спицами. Средний цвет — только когда карт нет.
   */
  accessory(m: HairMaterial, hm?: HairManifest | null): Promise<THREE.MeshStandardMaterial> {
    const albedo = m.albedo ? hm?.textures[m.albedo]?.file ?? null : null;
    const orm = m.orm ? hm?.textures[m.orm]?.file ?? null : null;
    return this.once(`acc:${albedo ?? m.fallbackColor ?? ''}:${orm ?? ''}`, async () => {
      const [map, ormMap] = await Promise.all([
        this.store.maybeTexture(albedo, 'color', { repeat: true }),
        this.store.maybeTexture(orm, 'data', { repeat: true }),
      ]);
      return new THREE.MeshStandardMaterial({
        name: 'hair_accessory',
        map,
        color: map ? new THREE.Color(1, 1, 1) : lin(m.fallbackColor ?? '#1d1c1e'),
        roughnessMap: ormMap,
        metalnessMap: ormMap,
        // зеркальный хром (RoughnessScale 0) без «светлячков» на env-карте
        roughness: ormMap ? 1 : Math.max(0.08, m.roughness ?? 0.5),
        metalness: ormMap ? 1 : (m.metalness ?? 0),
        envMap: this.env,
        envMapIntensity: 0.4,
      });
    });
  }

  dispose() {
    for (const p of this.cache.values()) p.then((m) => m.dispose()).catch(() => {});
    this.cache.clear();
    this.ready.clear();
    this.used.clear();
  }
}
