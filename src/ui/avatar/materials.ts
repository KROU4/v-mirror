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

/** Мягкое освещение кожи: красный канал «заворачивает» свет за терминатор (свет под кожей). */
const SKIN_LIGHTS = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
  'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );',
  `#ifdef SKIN_SSS
	float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.45 ) / 1.45 );
	vec3 sssIrr = mix( vec3( dotNL ), vec3( wrapNL ), uScatter ) * directLight.color;
	reflectedLight.directDiffuse += sssIrr * diffuseBRDF * ( 1.0 - F );
#else
	reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );
#endif`,
);
if (!SKIN_LIGHTS.includes('SKIN_SSS')) console.warn('avatar: шейдер кожи не пропатчен (изменился three.js)');

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
		f *= texture2D( uTintMask, vMapUv ).r;
	#endif
	diffuseColor.rgb = mix( c, tinted, f );
}
#endif
`;

/** Детальная нормаль (UV головы) и тайловые поры, по маске детализации из roughness.R. */
const DETAIL_GLSL = `mapN.xy *= normalScale;
#ifdef SKIN_DETAIL
{
	vec3 dN = texture2D( uDetailNormal, vNormalMapUv ).xyz * 2.0 - 1.0;
	float dMask = 1.0;
	#ifdef USE_ROUGHNESSMAP
		dMask = texture2D( roughnessMap, vRoughnessMapUv ).r;
	#endif
	vec2 add = uDetailW * dN.xy;
	#ifdef SKIN_MICRO
		vec2 muv = vNormalMapUv * uMicroScale;
		vec2 gx = dFdx( muv ) * vec2( 0.5, 1.0 );
		vec2 gy = dFdy( muv ) * vec2( 0.5, 1.0 );
		vec3 mN = textureGrad( uMicro, fract( muv ) * vec2( 0.5, 1.0 ), gx, gy ).xyz * 2.0 - 1.0;
		add += mN.xy * uMicroW * dMask;
	#endif
	mapN = normalize( vec3( mapN.xy + add, mapN.z ) );
}
#endif`;

interface SkinPatch {
  tint?: { color: THREE.Color; scale: number; mask?: THREE.Texture | null };
  detail?: { map: THREE.Texture; weight: number; micro?: THREE.Texture | null; microWeight: number; microScale: number };
  /** доля «завёрнутого» света по каналам RGB */
  scatter: THREE.Vector3;
  /** нижняя граница шероховатости */
  roughMin?: number;
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
  };
  mat.userData.skin = uniforms;
  mat.defines = { ...(mat.defines ?? {}), SKIN_SSS: '' };
  if (p.tint) mat.defines.SKIN_TINT = '';
  if (p.tint?.mask) mat.defines.SKIN_TINT_MASK = '';
  if (p.detail) mat.defines.SKIN_DETAIL = '';
  if (p.detail?.micro) mat.defines.SKIN_MICRO = '';
  mat.onBeforeCompile = (s: Shader) => {
    Object.assign(s.uniforms, uniforms);
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uTint; uniform float uTintScale; uniform sampler2D uTintMask;
uniform sampler2D uDetailNormal; uniform float uDetailW;
uniform sampler2D uMicro; uniform float uMicroW; uniform float uMicroScale;
uniform vec3 uScatter; uniform float uRoughMin;`,
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
      patchSkin(mat, { scatter: SKIN.scatter.clone() }, 'body');
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

  eyeWetness(e: EyeEntry): Promise<THREE.Material | null> {
    const w = e.eye_wetness;
    if (!w) return Promise.resolve(null);
    return this.once('wet:' + w.maps.maskA + w.params.ShadowColor, async () => {
      const mask = await this.store.texture(w.maps.maskA, 'data');
      return new THREE.MeshPhysicalMaterial({
        name: 'eye_wetness',
        color: lin(w.params.ShadowColor),
        alphaMap: mask,
        opacity: w.params.Intensity,
        transparent: true,
        depthWrite: false,
        roughness: 0.22,
        metalness: 0,
        envMap: this.env,
        envMapIntensity: 0.3,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
    });
  }

  lashes(e: LashEntry, doubled: boolean): Promise<THREE.MeshStandardMaterial> {
    const c = e.eyelashes.suggestedColor.product;
    return this.once('lash:' + e.eyelashes.maps.alpha + c, async () => {
      const alpha = await this.store.texture(e.eyelashes.maps.alpha, 'data', { repeat: true });
      return new THREE.MeshStandardMaterial({
        name: 'lashes',
        color: lin(c).multiplyScalar(0.6),
        alphaMap: alpha,
        alphaTest: 0.25,
        alphaToCoverage: true,
        side: doubled ? THREE.DoubleSide : THREE.FrontSide,
        roughness: 0.9,
        metalness: 0,
      });
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
      const mat = new THREE.MeshPhysicalMaterial({
        name: 'teeth',
        map,
        normalMap: normal,
        roughnessMap: orm,
        metalnessMap: ml ? orm : null,
        roughness: ml ? 1 : 0.85,
        metalness: ml ? 1 : 0,
        clearcoat: ml ? 0.3 : 0.15,
        clearcoatRoughness: 0.35,
        envMap: this.env,
        envMapIntensity: 0.5,
      });
      if (!ml && s.params.TintColor && mask) {
        patchSkin(mat, { tint: { color: lin(s.params.TintColor), scale: s.params.TintScale ?? 0, mask }, scatter: new THREE.Vector3(0.5, 0.2, 0.12), roughMin: 0.2 }, 'teeth');
      }
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

  standard(name: string, base: string, orm: string | undefined, normal: string | undefined, metal = true): Promise<THREE.MeshStandardMaterial> {
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
        metalnessMap: metal ? o : null,
        normalMap: n,
        roughness: 1,
        metalness: metal && o ? 1 : 0,
        envMap: this.env,
        envMapIntensity: 0.3,
      });
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
      const rough = THREE.MathUtils.clamp((m.roughnessBias ?? 0.15) + 0.5 * (m.roughnessScale ?? 0.15) + 0.25, 0.3, 0.6);
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
        envMapIntensity: 0.2,
      });
      const u = { uRamp: { value: ramp }, uShadow: { value: m.shadowStrength ?? 0.5 }, uIdGain: { value: 1.1 } };
      mat.onBeforeCompile = (s: Shader) => {
        Object.assign(s.uniforms, u);
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uRamp; uniform float uShadow; uniform float uIdGain;')
          .replace(
            '#include <map_fragment>',
            `{
	vec4 pk = texture2D( map, vMapUv );
	vec3 rt = texture2D( uRamp, vec2( pk.r, 0.25 ) ).rgb;
	vec3 id = texture2D( uRamp, vec2( pk.g, 0.75 ) ).rgb;
	vec3 col = rt * min( id * uIdGain, vec3( 1.0 ) );
	col *= mix( 1.0 - 0.5 * uShadow, 1.0, smoothstep( 0.0, 0.3, pk.r ) );
	diffuseColor.rgb *= col;
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
