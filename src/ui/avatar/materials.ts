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
  DecalMat,
  EyeEntry,
  HairManifest,
  HairMaterial,
  LashEntry,
  NailMat,
  SkinGender,
  TeethEntry,
} from './assets';

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
 * Мягкое освещение кожи: красный канал «заворачивает» свет за терминатор (свет под кожей).
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
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * mix( 1.0, 0.2, lightBehind( directLight.direction.z ) );
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
	mouthK *= uMouthLight * mix( 1.0, 0.2, gMouthDepth ) * smoothstep( -0.25, 0.35, directLight.direction.z );
	// Во рту остаётся рассеянный свет без оттенка ламп: голубой Fill иначе красит зубы в серо-зелёный
	lightCol = mix( vec3( dot( lightCol, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 1.0, 0.94, 0.86 ), lightCol, 0.25 );
#endif
	lightCol *= mouthK;
	vec3 irradiance = dotNL * lightCol;`,
  )
  .replace(
    'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );',
    `#ifdef SKIN_SSS
	float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.4 ) / 1.4 );
	vec3 sssIrr = mix( vec3( dotNL ), vec3( wrapNL ), uScatter ) * lightCol;
	reflectedLight.directDiffuse += sssIrr * diffuseBRDF * ( 1.0 - F );
#else
	reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );
#endif`,
  );
if (!SKIN_LIGHTS.includes('sssIrr') || !SKIN_LIGHTS.includes('mouthK *= uMouthLight') || !SKIN_LIGHTS.includes('mix( 1.0, 0.2, lightBehind')) console.warn('avatar: шейдер кожи не пропатчен (изменился three.js)');

/**
 * Блик прядей: от ламп из-за спины (контровые, холодный циан-белый) — слабый и в цвет
 * пряди. Белый скользящий блик GGX на тёмно-каштановых прядях читается серебристой сединой.
 */
const HAIR_LIGHTS = (RIM_MASK_GLSL + THREE.ShaderChunk.lights_physical_pars_fragment).replace(
  'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
  `vec3 hairSpecK = mix( vec3( 1.0 ), 0.2 * gHairTint, lightBehind( directLight.direction.z ) );
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * hairSpecK;`,
);
if (!HAIR_LIGHTS.includes('hairSpecK')) console.warn('avatar: шейдер волос не пропатчен (изменился three.js)');

/**
 * Ткань белья: в игре бельё матовое, а ORM даёт ему шероховатость латекса — на чашках
 * крупные белые пятна блика. Контровые лампы (из-за спины V) на ткани — слабая кайма,
 * а не неоновая полоса по краю чашки.
 */
const CLOTH_LIGHTS = (RIM_MASK_GLSL + THREE.ShaderChunk.lights_physical_pars_fragment)
  .replace(
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * mix( 1.0, 0.15, lightBehind( directLight.direction.z ) );',
  )
  .replace('vec3 irradiance = dotNL * directLight.color;', 'vec3 irradiance = dotNL * directLight.color * mix( 1.0, 0.35, lightBehind( directLight.direction.z ) );');
if (!CLOTH_LIGHTS.includes('mix( 1.0, 0.35, lightBehind')) console.warn('avatar: шейдер ткани не пропатчен (изменился three.js)');
const CLOTH_ROUGH_MIN = 0.68;

/**
 * Брови: блик контровых ламп (холодный циан-белый, скользящий) на тонких волосках читается
 * серебристо-белым хвостом брови — как у кожи и волос, от ламп из-за спины он почти гаснет.
 */
const BROW_LIGHTS = (RIM_MASK_GLSL + THREE.ShaderChunk.lights_physical_pars_fragment).replace(
  'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
  'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation * mix( 1.0, 0.1, lightBehind( directLight.direction.z ) );',
);
if (!BROW_LIGHTS.includes('mix( 1.0, 0.1, lightBehind')) console.warn('avatar: шейдер бровей не пропатчен (изменился three.js)');

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
const DETAIL_GLSL = `mapN.xy *= normalScale;
float lipFade = 1.0;
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
		vec2 muv = vNormalMapUv * uMicroScale;
		vec2 gx = dFdx( muv ) * vec2( 0.5, 1.0 );
		vec2 gy = dFdy( muv ) * vec2( 0.5, 1.0 );
		vec3 mN = textureGrad( uMicro, fract( muv ) * vec2( 0.5, 1.0 ), gx, gy ).xyz * 2.0 - 1.0;
		add += mN.xy * uMicroW * dMask;
	#endif
	mapN = normalize( vec3( mapN.xy + add * lipFade, mapN.z ) );
}
#endif`;

/**
 * Яркость прядей: рампы профиля в среднем по карточкам дают ≈ 1,5× светлее образца цвета
 * из каталога (brown_liquorice: #3e3933 против #322c28) — приводим к образцу. Чуть теплее
 * по каналам: под циановыми Fill-лампами каштановые пряди иначе выходят нейтрально-серыми.
 */
const HAIR_ALBEDO = new THREE.Vector3(0.8, 0.74, 0.7);

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
}

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
  mat.onBeforeCompile = (s: Shader) => {
    Object.assign(s.uniforms, uniforms);
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uTint; uniform float uTintScale; uniform sampler2D uTintMask;
uniform sampler2D uDetailNormal; uniform float uDetailW;
uniform sampler2D uMicro; uniform float uMicroW; uniform float uMicroScale;
uniform vec3 uScatter; uniform float uRoughMin; uniform float uMouthLight; uniform float uMouthOpen;
float gMouthDepth = 0.0;
float gEarMask = 0.0;`,
      )
      .replace('#include <lights_physical_pars_fragment>', SKIN_LIGHTS)
      // губы и веки в карте почти зеркальные — в кадре игры они лишь влажно блестят
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = max( roughnessFactor, uRoughMin );')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + TINT_GLSL)
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', DETAIL_GLSL));
  };
  mat.customProgramCacheKey = () => 'skin:' + key + ':' + Object.keys(mat.defines ?? {}).join(',');
}

const lin = (hex: string) => new THREE.Color(hex); // three переводит sRGB-hex в линейное рабочее пространство

/**
 * Кожа: шероховатость = ORM.G × 1 (кожа в игре довольно матовая), F0 ≈ 0,02,
 * доля «завёрнутого» света по RGB — красный уходит за терминатор дальше всех.
 */
const SKIN = { roughness: 1.0, specular: 0.5, scatter: new THREE.Vector3(0.45, 0.2, 0.12) };

/**
 * Знак каналов карты нормалей кожи головы. Касательные в glb идут по +u, но красный канал
 * карты игры направлен навстречу (геометрия выгружена зеркально): с X = +1 рельеф по
 * горизонтали инвертирован, верхняя губа и нижние веки «смотрят» вниз и ложатся бурой
 * полосой («усы», синяки под глазами), а на спинке носа горит ложный блик. Сверено с
 * рендером без карты нормалей: с X = −1 светотень совпадает, поры и складки остаются.
 */
export const HEAD_NORMAL_SCALE: [number, number] = [-1, 1];

/** Фабрика материалов одного движка: всё кешируется по ключу, текстуры — через AssetStore. */
export class Materials {
  private cache = new Map<string, Promise<THREE.Material>>();
  constructor(
    private store: AssetStore,
    private env: THREE.Texture | null,
  ) {}

  private once<T extends THREE.Material>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key);
    if (!p) {
      p = make();
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    return p as Promise<T>;
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
        this.store.maybeTexture(g.maps.microDetailNormal, 'data', { repeat: true }),
      ]);
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'head_skin',
        map,
        normalMap: normal,
        normalScale: new THREE.Vector2(...HEAD_NORMAL_SCALE),
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
      return new THREE.MeshPhysicalMaterial({
        name: 'eyeball',
        map,
        // склера в игре не «светится»: кадр тёмный, глаз затенён веком
        color: new THREE.Color(0.78, 0.76, 0.75),
        normalMap: normal,
        roughnessMap: orm,
        metalnessMap: e.eyeball.shader === 'multilayered_baked' ? orm : null,
        roughness: 1,
        metalness: e.eyeball.shader === 'multilayered_baked' ? 1 : 0,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        envMap: this.env,
        envMapIntensity: 0.9,
      });
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
          .replace('#include <alphamap_fragment>', LASH_ALPHA);
      };
      if (import.meta.env.DEV && !THREE.ShaderLib.lambert.fragmentShader.includes('#include <alphamap_fragment>')) console.warn('avatar: шейдер ресниц не пропатчен');
      mat.customProgramCacheKey = () => 'lashes:' + (single ? 1 : 0);
      return mat;
    });
  }

  brows(style: BrowStyle, colour: BrowColour, gradient: string): Promise<THREE.MeshStandardMaterial> {
    return this.once(`brow:${style.diffuseRGBA}:${gradient}:${colour.SecondaryDiffuseColor}`, async () => {
      const [diff, sec, normal, grad] = await Promise.all([
        this.store.texture(style.diffuseRGBA, 'data'),
        this.store.texture(style.secondaryAlpha, 'data'),
        this.store.maybeTexture(style.normal, 'data'),
        this.store.texture(gradient, 'color', { lut: true }),
      ]);
      const mat = new THREE.MeshStandardMaterial({
        name: 'brows',
        map: diff,
        normalMap: normal,
        normalScale: new THREE.Vector2(0.4, 0.4),
        transparent: true,
        depthWrite: false,
        roughness: 0.6,
        metalness: 0,
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
      };
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace('#include <lights_physical_pars_fragment>', BROW_LIGHTS)
          .replace(
            '#include <common>',
            `#include <common>
uniform sampler2D uSec; uniform sampler2D uGrad; uniform float uGradInt; uniform float uDiffAlpha; uniform float uSecInt; uniform vec3 uSecColor;`,
          )
          .replace(
            '#include <map_fragment>',
            `{
	vec4 d = texture2D( map, vMapUv );
	float aS = d.a * uDiffAlpha;
	vec3 cS = texture2D( uGrad, vec2( d.r, 0.5 ) ).rgb * uGradInt;
	float aB = texture2D( uSec, vMapUv ).g * uSecInt;
	float a = aS + aB * ( 1.0 - aS );
	vec3 c = ( cS * aS + uSecColor * aB * ( 1.0 - aS ) ) / max( a, 1e-4 );
	diffuseColor = vec4( c, a * opacity );
}`,
          );
      };
      mat.customProgramCacheKey = () => 'brows';
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
          scatter: new THREE.Vector3(0.5, 0.2, 0.12),
          roughMin: ml ? 0.2 : 0.45,
          mouth: true,
        },
        ml ? 'teeth_ml' : 'teeth',
      );
      return mat;
    });
  }

  // ---------------------------------------------------------------- руки и бельё
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

  standard(name: string, base: string, orm: string | undefined, normal: string | undefined, metal = true, cloth = false): Promise<THREE.MeshStandardMaterial> {
    return this.once('std:' + base + (cloth ? ':cloth' : ''), async () => {
      const [map, o, n] = await Promise.all([
        this.store.texture(base, 'color'),
        this.store.maybeTexture(orm, 'data'),
        this.store.maybeTexture(normal, 'data'),
      ]);
      const mat = new THREE.MeshStandardMaterial({
        name,
        map,
        roughnessMap: o,
        metalnessMap: metal ? o : null,
        normalMap: n,
        roughness: 1,
        metalness: metal && o ? 1 : 0,
        envMap: this.env,
        envMapIntensity: 0.3,
      });
      if (cloth) {
        mat.onBeforeCompile = (sh: Shader) => {
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <lights_physical_pars_fragment>', CLOTH_LIGHTS)
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = max( roughnessFactor, ${CLOTH_ROUGH_MIN.toFixed(2)} );`);
        };
        mat.customProgramCacheKey = () => 'cloth';
      }
      return mat;
    });
  }

  /** Полоски швов/молнии белья (metal_base decal): цвет = текстура × baseColorScale. */
  decal(d: DecalMat): Promise<THREE.MeshStandardMaterial> {
    const sc = d.baseColorScaleLinear ?? [1, 1, 1];
    return this.once(`decal:${d.baseColor}:${sc.join(',')}:${d.metalness}`, async () => {
      const [map, normal] = await Promise.all([this.store.texture(d.baseColor, 'color', { repeat: true }), this.store.maybeTexture(d.normal, 'data', { repeat: true })]);
      return new THREE.MeshStandardMaterial({
        name: 'garment_decal',
        map,
        normalMap: normal,
        color: new THREE.Color(sc[0], sc[1], sc[2]),
        roughness: d.roughness ?? 0.5,
        metalness: d.metalness ?? 0,
        transparent: true,
        alphaTest: 0.3,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
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
      };
      const hasDiff = !!diff;
      const hasSec = !!sec && !!mask;
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform sampler2D uLut; uniform float uDiffConst; uniform vec3 uCapColor; uniform sampler2D uSec; uniform float uSecInfl; uniform float uSecScale;',
          )
          .replace(
            '#include <map_fragment>',
            `{
	float g = ${hasDiff ? 'texture2D( map, vMapUv ).r' : 'uDiffConst'};
	diffuseColor.rgb = texture2D( uLut, vec2( g, 0.5 ) ).rgb * uCapColor;
}`,
          )
          .replace(
            '#include <alphamap_fragment>',
            `#include <alphamap_fragment>
${hasSec ? 'diffuseColor.a *= mix( 1.0, texture2D( uSec, vAlphaMapUv * uSecScale ).g, uSecInfl );' : ''}`,
          );
      };
      mat.customProgramCacheKey = () => `hair_cap:${hasDiff}:${hasSec}`;
      return mat;
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
  }
}
