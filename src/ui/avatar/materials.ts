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
  HairManifest,
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

const NOSE_ALBEDO_GLSL = `
#if defined( SKIN_NOSE ) && defined( USE_MAP )
{
	vec2 nq = ( vMapUv - vec2( 0.5, 0.285 ) ) / vec2( 0.085, 0.09 );
	float nm = ( 1.0 - smoothstep( 0.6, 1.0, length( nq ) ) ) * uNoseEven.x;
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
uniform float uSoftN; uniform vec3 uNoseEven;
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
gSoftN = normalize( mix( normal, nonPerturbedNormal, uSoftN ) );
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
 * Брови: множитель кадра для тёмной брови не больше этого (кожа под бровью темнеет хотя бы
 * до 35 %). Без предела на тонах 11–12 значок кожи темнее альбедо брови, и брови пропадали.
 */
export const BROW_DARK_MAX = 0.35;

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
    const toneKey = skinApp && g.skinTones[skinApp] ? skinApp : Object.keys(g.skinTones)[0];
    const tone = g.skinTones[toneKey];
    const entry = tone.byskinType[skinType] ?? Object.values(tone.byskinType)[0];
    const albedo = entry?.albedo ?? g.skinTypes[skinType]?.albedo ?? Object.values(g.skinTypes)[0].albedo;
    const tintColor = entry?.tintColor ?? tone.tintColor;
    const tintScale = entry?.tintScale ?? tone.tintScale;
    return this.once(`head:${gender}:${albedo}:${tintColor}:${tintScale}`, async () => {
      const [map, normal, rough, detail, micro] = await Promise.all([
        this.store.texture(albedo, 'color'),
        this.store.texture(g.maps.normal, 'data'),
        this.store.texture(g.maps.roughness, 'data'),
        this.store.maybeTexture(g.maps.detailNormal, 'data'),
        this.store.maybeTexture(g.maps.microDetailNormal, 'data', { repeat: true }).then(microTile),
      ]);
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'head_skin',
        map,
        normalMap: normal,
        normalScale: new THREE.Vector2(...SKIN_NORMAL_SCALE),
        roughnessMap: rough,
        roughness: SKIN.roughness,
        metalness: 0,
        specularIntensity: SKIN.specular,
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
    });
  }

  /** Тело и руки: альбедо уже запечено под тон (textures.<g>_<part>.albedoByTone). */
  bodySkin(set: BodyTexSet, part: string, tone: string): Promise<THREE.MeshPhysicalMaterial> {
    const albedo = set.albedoByTone[tone] ?? Object.values(set.albedoByTone)[0];
    return this.once(`body:${part}:${albedo}`, async () => {
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
        specularIntensity: SKIN.specular,
        envMap: this.env,
        envMapIntensity: 0.12,
      });
      // Как у головы: с более гладкой кожей ключицы и грудь блестят белыми полосами
      patchSkin(mat, { scatter: SKIN.scatter.clone(), roughMin: 0.6 }, 'body');
      return mat;
    });
  }

  // ---------------------------------------------------------------- глаза, ресницы, брови, зубы
  eyeball(e: EyeEntry): Promise<THREE.MeshPhysicalMaterial> {
    const m = e.eyeball.maps;
    return this.once('eye:' + m.albedo, async () => {
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
        color: new THREE.Color(0.78, 0.76, 0.75),
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
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLashLow = lashLow;');
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
   * Брови — декаль поверх кожи, как в игре: там декаль заменяет альбедо кожи и освещается
   * светом кожи (с её подповерхностным рассеянием и тоном). Здесь это умножение кадра на
   * отношение «цвет брови / альбедо кожи» (не больше 1) с долей альфы: тёмная бровь всегда
   * темнее кожи под ней, оттенок и свет — от кожи. Отдельно освещённые брови (свой блик, без
   * рассеяния) читались серыми и на тонах 10–12 светлее кожи, а светлая подложка
   * (SecondaryDiffuseColor) рисовала бледные штрихи у кончиков стиля 12.
   * skinHex — значок тона кожи (средний цвет кожи лба в sRGB).
   */
  brows(style: BrowStyle, colour: BrowColour, gradient: string, skinHex = '#a8886b'): Promise<THREE.MeshBasicMaterial> {
    return this.once(`brow:${style.diffuseRGBA}:${gradient}:${colour.SecondaryDiffuseColor}:${skinHex}`, async () => {
      const [diff, sec, grad] = await Promise.all([
        this.store.texture(style.diffuseRGBA, 'data'),
        this.store.texture(style.secondaryAlpha, 'data'),
        this.store.texture(gradient, 'color', { lut: true }),
      ]);
      const mat = new THREE.MeshBasicMaterial({
        name: 'brows',
        map: diff,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        // кадр × множитель: кожа под бровью только темнеет
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.DstColorFactor,
        blendDst: THREE.ZeroFactor,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
      const u = {
        uSec: { value: sec },
        uGrad: { value: grad },
        uGradInt: { value: colour.GradientMapIntensity },
        uDiffAlpha: { value: colour.DiffuseAlpha },
        uSecInt: { value: colour.SecondaryDiffuseAlphaIntensity },
        uSecColor: { value: lin(colour.SecondaryDiffuseColor) },
        uSkin: { value: lin(skinHex) },
      };
      keepUniforms(mat, u);
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
uniform sampler2D uSec; uniform sampler2D uGrad; uniform float uGradInt; uniform float uDiffAlpha; uniform float uSecInt; uniform vec3 uSecColor; uniform vec3 uSkin;`,
          )
          .replace(
            '#include <map_fragment>',
            `{
	vec4 d = texture2D( map, vMapUv );
	float aS = d.a * uDiffAlpha;
	vec3 cS = texture2D( uGrad, vec2( d.r, 0.5 ) ).rgb * uGradInt;
	float aB = texture2D( uSec, vMapUv ).g * uSecInt;
	float a = clamp( aS + aB * ( 1.0 - aS ), 0.0, 1.0 );
	vec3 c = ( cS * aS + uSecColor * aB * ( 1.0 - aS ) ) / max( a, 1e-4 );
	// Светлота — отношение яркостей брови и кожи; оттенок брови — только в меру её
	// насыщенности: значок кожи теплее и насыщеннее реального альбедо, и полное отношение
	// цветов уводило натуральные коричневые брови в серо-голубой
	const vec3 LUM = vec3( 0.2126, 0.7152, 0.0722 );
	float rel = dot( c, LUM ) / max( dot( uSkin, LUM ), 1e-4 );
	float mx = max( c.r, max( c.g, c.b ) );
	float sat = ( mx - min( c.r, min( c.g, c.b ) ) ) / max( mx, 1e-4 );
	vec3 hueC = c / max( dot( c, LUM ), 1e-4 );
	vec3 hueS = uSkin / max( dot( uSkin, LUM ), 1e-4 );
	vec3 k = rel * mix( vec3( 1.0 ), hueC / hueS, smoothstep( 0.45, 0.85, sat ) );
	// Тёмные волоски (каштан, чёрный, мерло) и на тёмной коже темнее её: пряди затеняют друг
	// друга. На тонах 11–12 альбедо такой брови светлее кожи, и без предела бровь пропадала.
	// Светлые брови (блонд, платина, пастель) предела не имеют
	float darkHair = 1.0 - smoothstep( 0.05, 0.16, dot( c, LUM ) );
	k = clamp( min( k, vec3( mix( 1.0, ${g4(BROW_DARK_MAX)}, darkHair ) ) ), 0.0, 1.0 );
	diffuseColor = vec4( mix( vec3( 1.0 ), k, a * opacity ), 1.0 );
}`,
          );
      };
      mat.customProgramCacheKey = () => 'brows_mul';
      return mat;
    });
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
   * альбедо уже под тон, ORM.G — шероховатость. Части лежат на коже тела вплотную, поэтому
   * чуть сдвинуты к камере по глубине.
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
        specularIntensity: SKIN.specular,
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
  intimateDecal(name: string, m: IntimateDecalMat, pubic: boolean): Promise<THREE.MeshStandardMaterial> {
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
      const u = { uRamp: { value: ramp }, uShadow: { value: m.shadowStrength ?? 0.5 }, uIdGain: { value: 1.0 }, uSpec: { value: 0.4 }, uAlbedo: { value: HAIR_ALBEDO } };
      keepUniforms(mat, u);
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uRamp; uniform float uShadow; uniform float uIdGain; uniform float uSpec; uniform vec3 uAlbedo;\nvec3 gHairTint = vec3( 1.0 );')
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
        uAlbedo: { value: HAIR_ALBEDO },
        uStubble: { value: new THREE.Vector3(CAP_STUBBLE.scale, CAP_STUBBLE.floor, CAP_STUBBLE.radius) },
      };
      keepUniforms(mat, u);
      const hasDiff = !!diff;
      const hasSec = !!sec && !!mask;
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
uniform sampler2D uLut; uniform float uDiffConst; uniform vec3 uCapColor; uniform sampler2D uSec; uniform float uSecInfl; uniform float uSecScale;
uniform vec3 uAlbedo; uniform vec3 uStubble;
${STUBBLE_GLSL}`,
          )
          .replace('#include <lights_physical_pars_fragment>', CAP_LIGHTS)
          .replace(
            '#include <map_fragment>',
            `{
	float g = ${hasDiff ? 'texture2D( map, vMapUv ).r' : 'uDiffConst'};
	diffuseColor.rgb = texture2D( uLut, vec2( g, 0.5 ) ).rgb * uCapColor * uAlbedo;
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
   */
  beardShadow(hm: HairManifest, m: HairMaterial): Promise<THREE.MeshStandardMaterial> {
    const mask = m.mask ? hm.textures[m.mask]?.file ?? null : null;
    return this.once(`beardShadow:${mask}:${m.diffuseColor}:${m.diffuseAlpha}`, async () => {
      const alpha = await this.store.texture(mask ?? '', 'data');
      return new THREE.MeshStandardMaterial({
        name: 'beard_shadow',
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

  accessory(m: HairMaterial): Promise<THREE.MeshStandardMaterial> {
    return this.once('acc:' + (m.fallbackColor ?? ''), async () =>
      new THREE.MeshStandardMaterial({
        name: 'hair_accessory',
        color: lin(m.fallbackColor ?? '#1d1c1e'),
        roughness: m.roughness ?? 0.5,
        metalness: m.metalness ?? 0,
        envMap: this.env,
        envMapIntensity: 0.4,
      }),
    );
  }

  dispose() {
    for (const p of this.cache.values()) p.then((m) => m.dispose()).catch(() => {});
    this.cache.clear();
    this.ready.clear();
    this.used.clear();
  }
}
