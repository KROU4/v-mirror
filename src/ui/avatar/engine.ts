// 3D-персонаж V из файлов игры: рендерер, сцена редактора, цикл кадров.
// Модуль грузится лениво (отдельный чанк с three.js) и только когда выгрузка есть.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Gender } from '../../model/catalog';
import { AssetStore } from './assets';
import { Character } from './character';
import type { AvatarLook } from './look';
import { Materials, texturesOf } from './materials';
import { FrameStats, initialPixelRatio, nextPixelRatio } from './perf';
import { bodyModeFor, cameraShot, cameraSlotFor, type CameraSlot } from './slots';
import { CameraRig, LightRig } from './stage';

export type { AvatarLook } from './look';

/** Скорость поворота V при зажатой Q/E, °/с (в игре поворот идёт, пока клавиша нажата). */
export const SPIN_DEG_PER_S = 150;

export interface SlotFocus {
  slotId?: string;
  group?: string;
  variantName?: string;
}

export interface EngineEvents {
  /** вид не надевается (файлы набора не читаются): сцену надо снять */
  onError?: (e: unknown) => void;
  /** контекст WebGL потерян / восстановлен браузером */
  onContext?: (state: 'lost' | 'restored') => void;
  /**
   * V с последним видом нарисована (конец каждого удачного setLook, в том числе повторного
   * после догрузки зубов и ногтей): по нему интерфейс снимает «Загрузка V»
   */
  onShown?: () => void;
}

/** Тело, на котором V сейчас не стоит, держим столько, потом освобождаем (на слабых устройствах — сразу). */
export const IDLE_BODY_MS = 45_000;
/** Сенсорное устройство без ввода: кадры не чаще 30 в секунду (батарея). */
export const IDLE_FPS_TOUCH = 30;
/** Мышь и клавиатура без ввода: не чаще 60 в секунду (на мониторе 144 Гц V только дышит и моргает). */
export const IDLE_FPS = 60;
/** Сколько видеопамяти под текстуры держать (МБ, RGBA8 с мипами): обычное устройство / мало памяти. */
export const TEXTURE_BUDGET_MB = { normal: 192, low: 96 };

const lowMemory = () => ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** Сторона тени для карты глубины, как в WebGLShadowMap three.js. */
const SHADOW_SIDE: Record<number, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

export class AvatarEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private rig = new CameraRig();
  /** телефоны и планшеты: deviceMemory у Android часто 4–8, у iOS его нет вовсе */
  private coarse = coarsePointer();
  private lights = new LightRig(this.coarse || lowMemory());
  private store = new AssetStore();
  private mats: Materials;
  private env: THREE.Texture | null = null;
  private envIdle = 0;
  /** чем запланирована сборка окружения: отменять надо тем же планировщиком */
  private envIdleKind: 'ric' | 'timeout' = 'timeout';
  private characters: Partial<Record<Gender, Promise<Character>>> = {};
  private active: Character | null = null;
  private stageGroup = new THREE.Group();
  private token = 0;
  private hairToken = 0;
  private intimateToken = 0;
  private lastLook: AvatarLook | null = null;
  private slot: CameraSlot = 'UI_Skin';
  private yawTarget = 0;
  private yaw = 0;
  /** −1, 0, 1 — пока зажата Q или E */
  private spin = 0;
  private followW = 0;
  private drift = new THREE.Vector3();
  private follow = new THREE.Vector3();
  private raf = 0;
  private last = performance.now();
  private visible = !document.hidden;
  /** холст в окне (не прокручен за край, не скрыт) */
  private onscreen = true;
  private io: IntersectionObserver | null = null;
  private frames = new FrameStats();
  private dpr: number;
  private dprCeil = Infinity;
  private size: [number, number, number, number, number] | null = null;
  /** сборок шейдеров в работе: пока они идут, кадр не рисуем (иначе главный поток ждёт драйвер) */
  private compiling = 0;
  private frameWaiters: (() => void)[] = [];
  private bodyTimers: Partial<Record<Gender, number>> = {};
  private lastInput = performance.now();
  /** накопленное время до следующего кадра в простое (с переносом остатка) */
  private sinceDraw = 0;
  /** время с прошлого нарисованного кадра в простое (dt анимации) */
  private idleElapsed = 0;
  private idleDraws = 0;
  private canvas: HTMLCanvasElement;
  disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    private events: EngineEvents = {},
  ) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    // Проверка каждой новой программы (getProgramInfoLog) ждёт драйвер на главном потоке:
    // в сборке для пользователей шейдеры уже проверены
    this.renderer.debug.checkShaderErrors = !import.meta.env.PROD;
    this.dpr = initialPixelRatio(window.devicePixelRatio);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Экспозиция в игре фиксированная (automated 0)
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.store.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    // Очень слабое нейтральное окружение — только для бликов глаз, зубов и ногтей. Сборка
    // PMREM занимает ~0,8 с главного потока: строим её в простое, пока грузятся файлы V
    const env = new Promise<THREE.Texture | null>((resolve) => {
      const build = () => {
        if (this.disposed) return resolve(null);
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
        resolve(this.env);
      };
      if (typeof window.requestIdleCallback === 'function') {
        this.envIdleKind = 'ric';
        this.envIdle = window.requestIdleCallback(build, { timeout: 400 });
      } else {
        this.envIdleKind = 'timeout';
        this.envIdle = window.setTimeout(build, 50);
      }
    });
    this.mats = new Materials(this.store, env);
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) canvas.addEventListener(ev, this.onInput, { passive: true });
    this.scene.add(this.lights.group, this.stageGroup);
    this.rig.camera.updateProjectionMatrix();
    document.addEventListener('visibilitychange', this.onVisibility);
    // Холст за краем окна (прокрутка на телефоне) — кадры не рисуем
    if (typeof IntersectionObserver === 'function') {
      this.io = new IntersectionObserver((es) => {
        const on = es.some((e) => e.isIntersecting);
        if (on === this.onscreen) return;
        this.onscreen = on;
        this.onVisibility();
      });
      this.io.observe(canvas);
    }
    this.loop();
  }

  private onVisibility = () => {
    this.visible = !document.hidden && this.onscreen;
    if (this.visible) {
      this.last = performance.now(); // после паузы не прыгаем на всё пропущенное время
      this.frames.reset();
      this.loop();
    }
  };

  private onLost = (e: Event) => {
    e.preventDefault(); // браузер вернёт контекст, если сможет
    this.events.onContext?.('lost');
  };

  private onRestored = () => {
    this.events.onContext?.('restored');
  };

  private onInput = () => {
    this.lastInput = performance.now();
  };

  /**
   * V стоит, камера не едет, ничего не грузится и 2 с не было ввода: кадры реже —
   * 30 к/с на сенсорных устройствах, 60 к/с с мышью (вместо частоты монитора, 120–144).
   */
  private idleThrottle(now: number): boolean {
    if (this.spin || this.compiling || now < this.quietUntil || now - this.lastInput < 2000) return false;
    return !this.rig.moving && Math.abs(this.yawTarget - this.yaw) < 0.05;
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const ms = now - this.last;
    if (this.idleThrottle(now)) {
      this.last = now;
      const interval = 1000 / (this.coarse ? IDLE_FPS_TOUCH : IDLE_FPS);
      this.sinceDraw += ms;
      this.idleElapsed += ms;
      // −2 мс: кадр монитора чуть короче номинала, иначе 60 Гц на мониторе 60 Гц стали бы 30.
      // Остаток переносится (а не обнуляется): на 144 Гц кадры ложатся то через 2, то через
      // 3 обновления монитора, и в среднем выходит ровно 60 к/с, а не 48
      if (this.sinceDraw < interval - 2) return;
      this.sinceDraw = Math.min(this.sinceDraw - interval, interval);
      const dt = Math.min(this.idleElapsed / 1000, 0.1);
      this.idleElapsed = 0;
      // В простое V только дышит и моргает: тени пересчитываются через кадр
      const sm = this.renderer.shadowMap;
      sm.autoUpdate = false;
      if (this.idleDraws++ % 2 === 0) sm.needsUpdate = true;
      this.frame(dt);
      return;
    }
    this.sinceDraw = 0;
    this.idleElapsed = 0;
    this.idleDraws = 0;
    this.renderer.shadowMap.autoUpdate = true;
    const dt = Math.min(ms / 1000, 0.1);
    this.last = now;
    // Пока драйвер собирает шейдеры новых материалов, кадр не рисуем: холст держит прошлый
    if (this.compiling > 0) return;
    this.frame(dt);
    this.adaptQuality(ms);
    if (this.frameWaiters.length) for (const w of this.frameWaiters.splice(0)) w();
  };

  /** Resolves after the next frame has been drawn (or at once when the loop is paused). */
  private nextFrame(): Promise<void> {
    if (!this.visible || this.disposed) return Promise.resolve();
    return new Promise((r) => this.frameWaiters.push(r));
  }

  /**
   * Материалы, только что надетые на объект, собираются параллельно (KHR_parallel_shader_compile),
   * а не при первом кадре: иначе главный поток секундами ждёт драйвер (GetProgramiv).
   */
  private async precompile(obj: THREE.Object3D) {
    this.compiling++;
    try {
      await Promise.all([this.renderer.compileAsync(obj, this.rig.camera, this.scene), this.precompileShadows(obj)]);
      await this.uploadTextures(obj);
    } catch {
      /* не собралось заранее — соберётся при отрисовке */
    } finally {
      this.compiling--;
    }
  }

  /**
   * Программы карты теней. compileAsync собирает только материалы сцены, а глубину для
   * теней three рисует своим MeshDepthMaterial — для мешей со скинингом и морфами эти
   * программы собирались синхронно в первом кадре (~1,2 с). Здесь для каждого меша,
   * отбрасывающего тень, собирается та же программа на заместителе (та же геометрия, тот же
   * скелет, MeshDepthMaterial с теми же картами, стороной и alphaTest, что выставит
   * WebGLShadowMap), при выводе в render target (без тональной компрессии, как у тени).
   * Кеш программ three находит их по ключу, и кадр берёт готовые.
   */
  private shadowRT: THREE.WebGLRenderTarget | null = null;
  private async precompileShadows(obj: THREE.Object3D) {
    if (!this.renderer.shadowMap.enabled) return;
    const proxies = new THREE.Scene();
    const mats: THREE.MeshDepthMaterial[] = [];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.castShadow || !m.visible || Array.isArray(m.material) || !m.material) return;
      const src = m.material as THREE.MeshStandardMaterial;
      const d = new THREE.MeshDepthMaterial();
      d.side = src.shadowSide ?? SHADOW_SIDE[src.side];
      d.alphaMap = src.alphaMap ?? null;
      d.alphaTest = src.alphaToCoverage ? 0.5 : src.alphaTest;
      d.map = src.map ?? null;
      mats.push(d);
      let p: THREE.Mesh;
      const sm = m as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) {
        const s = new THREE.SkinnedMesh(m.geometry, d);
        s.bind(sm.skeleton, sm.bindMatrix);
        p = s;
      } else p = new THREE.Mesh(m.geometry, d);
      p.frustumCulled = false;
      proxies.add(p);
    });
    if (!mats.length) return;
    this.shadowRT ??= new THREE.WebGLRenderTarget(1, 1);
    const prev = this.renderer.getRenderTarget();
    let done: Promise<unknown>;
    // Параметры программ (тональная компрессия, цветовое пространство) считаются в compile()
    // синхронно — по текущему render target
    this.renderer.setRenderTarget(this.shadowRT);
    try {
      done = this.renderer.compileAsync(proxies, this.rig.camera, this.scene);
    } finally {
      this.renderer.setRenderTarget(prev);
    }
    try {
      await done;
    } finally {
      // Программа живёт, пока ей пользуется хоть один материал: заместители держим, пока
      // кадр с тенью не взял её себе
      window.setTimeout(() => mats.forEach((d) => d.dispose()), 4000);
    }
  }

  /**
   * Загрузка текстур в видеопамять до первого кадра, по одной с передышкой: иначе все
   * новые карты (десятки мегабайт с мипами) грузятся в одном кадре.
   */
  private uploaded = new WeakSet<THREE.Texture>();
  private async uploadTextures(obj: THREE.Object3D) {
    const tex = new Set<THREE.Texture>();
    obj.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!(o as THREE.Mesh).isMesh || !m || !o.visible) return;
      for (const x of Array.isArray(m) ? m : [m]) texturesOf(x, tex);
    });
    let t0 = performance.now();
    for (const t of tex) {
      if (this.disposed) return;
      if (this.uploaded.has(t) || !t.image) continue;
      this.uploaded.add(t);
      this.renderer.initTexture(t);
      if (performance.now() - t0 > 12) {
        await new Promise((r) => setTimeout(r, 0));
        t0 = performance.now();
      }
    }
  }

  /**
   * Слабая видеокарта: плотность пикселей шагами вниз, пока кадр не уложится в ~45 к/с.
   * Пока что-то грузится (вид, причёска, нагота, смена размера), кадры не считаются:
   * загрузка текстур и сборка шейдеров дают долгие кадры, которые о видеокарте не говорят.
   */
  private quietUntil = 0;
  private hold(ms = 1500) {
    this.quietUntil = Math.max(this.quietUntil, performance.now() + ms);
    this.frames.reset();
  }

  private adaptQuality(ms: number) {
    if (!this.active || performance.now() < this.quietUntil) return;
    this.frames.push(ms);
    if (!this.frames.full) return;
    const next = nextPixelRatio(this.dpr, this.frames.medianMs, window.devicePixelRatio, this.dprCeil);
    this.frames.reset();
    if (next === this.dpr) return;
    if (next < this.dpr) this.dprCeil = next;
    this.dpr = next;
    this.renderer.setPixelRatio(next);
    if (this.size) this.resize(...this.size);
    this.hold(500);
  }

  /** Частота кадров и нагрузка (для проверки производительности). */
  get stats() {
    const info = this.renderer.info;
    return {
      programs: info.programs?.length ?? 0,
      storeTextures: this.store.textureCount,
      storeTextureMB: this.store.textureMB,
      materials: this.mats.size,
      fps: Math.round(this.frames.fps * 10) / 10,
      frameMs: Math.round(this.frames.avgMs * 100) / 100,
      pixelRatio: this.dpr,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  private frame(dt: number) {
    this.rig.update(dt);
    // Поворот: Q/E держат постоянную скорость, цель отслеживается с инерцией (yawSpeed куклы)
    if (this.spin) this.yawTarget += this.spin * SPIN_DEG_PER_S * dt;
    this.yaw += (this.yawTarget - this.yaw) * (1 - Math.exp(-dt * 8));
    const ch = this.active;
    if (ch) {
      ch.root.rotation.y = THREE.MathUtils.degToRad(this.yaw);
      ch.root.updateMatrixWorld(true);
      // Улыбка «Зубы» ждёт только выхода из позы ногтей: там рука ещё опускается, голова
      // наклонена, и улыбка поверх этого выглядит оскалом исподлобья. Переезд «рост → крупный
      // план» её не задерживает — лицевой граф игры от клипа тела не зависит
      ch.face.teethTarget = this.slot === 'UI_Teeth' && !ch.anim.handUp ? 1 : 0;
      ch.update(dt, this.rig.camera.position);
      // Крупные планы: прицел мягко идёт за головой по горизонтали и глубине. Вход в
      // слежение быстрый: при переезде «рост → лицо» клип ui_fullbody_to_closeup уводит голову
      // вбок, и с медленным входом (0,6 с) лицо успевало уехать под левую колонку, пока камера
      // уже подъехала. Издали сдвиг прицела на сантиметры незаметен, так что рывка нет.
      const want = bodyModeFor(this.slot) === 'closeup' ? 1 : 0;
      this.followW += (want - this.followW) * (1 - Math.exp(-dt / (want > this.followW ? 0.15 : 0.6)));
      ch.headDrift(this.drift);
      this.drift.y = 0;
      this.drift.multiplyScalar(this.followW);
      this.follow.lerp(this.drift, 1 - Math.exp(-dt / 0.18));
      this.rig.setFollow(this.follow);
    }
    this.renderer.render(this.scene, this.rig.camera);
  }

  private characterFor(g: Gender): Promise<Character> {
    window.clearTimeout(this.bodyTimers[g]);
    let p = this.characters[g];
    if (!p) {
      p = Character.build(g, this.store, this.mats);
      p.catch(() => delete this.characters[g]);
      this.characters[g] = p;
    }
    return p;
  }

  /** Другое тело не на сцене: освобождаем его через IDLE_BODY_MS (на телефонах и при малой памяти — сразу). */
  private scheduleRelease(g: Gender) {
    window.clearTimeout(this.bodyTimers[g]);
    const release = () => {
      const p = this.characters[g];
      if (!p || this.active?.gender === g || this.lastLook?.gender === g) return;
      delete this.characters[g];
      p.then((c) => {
        c.dispose();
        // текстуры и материалы, которыми не пользуется оставшееся тело
        this.trimMemory();
      }).catch(() => {});
    };
    if (lowMemory() || this.coarse) release();
    else this.bodyTimers[g] = window.setTimeout(release, IDLE_BODY_MS);
  }

  /**
   * Надеть вид. Последний вызов побеждает. true — V этого вызова на сцене
   * (false — вызов вытеснен следующим). Причёска догружается после.
   */
  async setLook(look: AvatarLook): Promise<boolean> {
    const my = ++this.token;
    this.lastLook = look;
    this.hold(4000);
    const ch = await this.characterFor(look.gender);
    if (this.disposed || my !== this.token) return false;
    const apply = await ch.prepare(look);
    if (this.disposed || my !== this.token) return false;
    this.hold();
    this.compiling++;
    try {
      if (this.active !== ch) {
        const prev = this.active;
        if (prev) this.stageGroup.remove(prev.root);
        this.stageGroup.add(ch.root);
        this.active = ch;
        this.lights.setGender(look.gender);
        this.applySlot(true);
        if (prev && prev !== ch) this.scheduleRelease(prev.gender);
      }
      apply();
      await this.precompile(ch.root);
    } finally {
      this.compiling--;
    }
    if (this.disposed || my !== this.token) return false;
    this.updateHair(look);
    this.updateBeard(look);
    this.updateIntimate(look);
    this.scheduleTrim();
    // Зубы, ногти и клипы тела — фоном; когда придут, вид надевается ещё раз
    ch.loadExtras(() => {
      if (!this.disposed && this.active === ch && this.lastLook) void this.setLook(this.lastLook).catch((e) => this.events.onError?.(e));
    });
    // «Готово» — когда V действительно нарисована, а не когда собраны данные
    await this.nextFrame();
    const shown = !this.disposed && my === this.token;
    // Повторный setLook из loadExtras вытесняет вызов, который ждёт интерфейс, — событие
    // приходит от того вызова, что дошёл до конца
    if (shown) this.events.onShown?.();
    return shown;
  }

  /**
   * Видеопамять: материалы, которых нет ни на одном меше живых тел (включая причёски и части
   * наготы в кеше недавних), и текстуры без материалов освобождаются. Держим ещё несколько
   * последних материалов, чтобы листание вперёд-назад не грузило их заново.
   */
  private trimTimer = 0;
  private scheduleTrim() {
    window.clearTimeout(this.trimTimer);
    this.trimTimer = window.setTimeout(() => this.trimMemory(), 1500);
  }

  trimMemory() {
    if (this.disposed) return;
    // Материал ещё собирается: его уже загруженные текстуры ни в одном материале не числятся,
    // и чистка освободила бы их из-под него (он достроится с удалённой текстурой) — ждём
    if (this.mats.pending > 0) {
      this.scheduleTrim();
      return;
    }
    const live = new Set<THREE.Material>();
    const chars = Object.values(this.characters);
    Promise.allSettled(chars).then((rs) => {
      if (this.disposed) return;
      if (this.mats.pending > 0) return this.scheduleTrim();
      for (const r of rs) if (r.status === 'fulfilled') r.value.collectMaterials(live);
      // Недавние материалы держим, пока их текстуры укладываются в бюджет видеопамяти
      const small = lowMemory() || this.coarse;
      const budget = small ? TEXTURE_BUDGET_MB.low : TEXTURE_BUDGET_MB.normal;
      let keep = small ? 12 : 40;
      let keepTex = this.mats.trim(live, keep);
      while (keep > 0 && this.store.sizeMB(keepTex) > budget) {
        keep = Math.floor(keep / 2);
        keepTex = this.mats.trim(live, keep);
      }
      this.store.trim(keepTex);
    });
  }

  /** Новые меши и материалы причёски/наготы/слоёв головы: собрать шейдеры, потом показать. */
  private async show(ch: Character, apply: () => void) {
    this.compiling++;
    try {
      apply();
      await this.precompile(ch.root);
    } finally {
      this.compiling--;
    }
    this.hold();
    this.scheduleTrim();
  }

  private async updateHair(look: AvatarLook) {
    const my = ++this.hairToken;
    const ch = this.active;
    if (!ch) return;
    try {
      const apply = await ch.prepareHair(look);
      if (this.disposed || my !== this.hairToken || this.active !== ch) return;
      await this.show(ch, apply);
    } catch {
      /* причёска не загрузилась — V остаётся без неё */
    }
  }

  private beardToken = 0;
  private async updateBeard(look: AvatarLook) {
    const my = ++this.beardToken;
    const ch = this.active;
    if (!ch) return;
    try {
      const apply = await ch.prepareBeard(look);
      if (this.disposed || my !== this.beardToken || this.active !== ch) return;
      await this.show(ch, apply);
    } catch (e) {
      // в наборе нет бород (собран старой версией) — V без бороды
      if (import.meta.env.DEV) console.warn('[avatar] борода:', e);
    }
  }

  /** Соски, тату и шрамы тела, гениталии, лобковые волосы — догружаются, как причёска. */
  private async updateIntimate(look: AvatarLook) {
    const my = ++this.intimateToken;
    const ch = this.active;
    if (!ch) return;
    try {
      const apply = await ch.prepareIntimate(look);
      if (this.disposed || my !== this.intimateToken || this.active !== ch) return;
      await this.show(ch, apply);
    } catch (e) {
      // в наборе нет body/intimate.json — V без частей наготы
      if (import.meta.env.DEV) console.warn('[avatar] нагота:', e);
    }
  }

  /** Выбранная строка каталога: кадр камеры и поза. */
  setFocus(f: SlotFocus) {
    const slot = cameraSlotFor(f.slotId, f.group, f.variantName);
    if (slot === this.slot) return;
    this.slot = slot;
    this.lastInput = performance.now();
    this.applySlot(false);
  }

  private applySlot(immediate: boolean) {
    const ch = this.active;
    if (!ch) return;
    this.rig.setShot(cameraShot(this.slot, ch.gender), immediate);
    ch.anim.request(bodyModeFor(this.slot));
  }

  setYaw(deg: number) {
    if (deg !== this.yawTarget) this.lastInput = performance.now();
    this.yawTarget = deg;
  }

  /** Непрерывный поворот: dir = −1 / 1 пока клавиша зажата, 0 — стоп. Угол не ограничен. */
  setSpin(dir: number) {
    this.spin = Math.sign(dir);
    this.lastInput = performance.now();
  }

  /** Целевой угол поворота, ° (после вращения клавишами его забирает интерфейс). */
  get yawDeg() {
    return this.yawTarget;
  }

  /**
   * gapLeft..gapRight — видимый промежуток холста между колонками интерфейса (в пикселях
   * холста). Персонаж встаёт в его середину и уменьшается, если промежуток узкий.
   * insetBottom — сколько пикселей снизу закрыто плашкой описания (на телефоне): кадр
   * ужимается в оставшуюся высоту и поднимается, чтобы рот и подбородок не уходили под неё.
   */
  resize(w: number, h: number, gapLeft = 0, gapRight = w, insetBottom = 0) {
    if (w < 1 || h < 1) return;
    this.size = [w, h, gapLeft, gapRight, insetBottom];
    this.renderer.setSize(w, h, false);
    this.hold(500);
    const cam = this.rig.camera;
    cam.aspect = w / h;
    const gap = Math.max(1, gapRight - gapLeft);
    const inset = THREE.MathUtils.clamp(insetBottom, 0, h * 0.4);
    // Почти квадратный холст (телефон): кадр слотов рассчитан на широкий экран, и на крупных
    // планах макушка уходит за верхний край — отъезжаем чуть дальше
    const narrow = w / h < 1.3 ? 0.86 : 1;
    cam.zoom = Math.min(1, (gap / h) * 1.3) * ((h - inset) / h) * narrow;
    const center = (gapLeft + gapRight) / 2 / w;
    cam.setViewOffset(w, h, (0.5 - center) * w, inset / 2, w, h);
    cam.updateProjectionMatrix();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.token++;
    this.hairToken++;
    this.beardToken++;
    this.intimateToken++;
    cancelAnimationFrame(this.raf);
    for (const w of this.frameWaiters.splice(0)) w();
    for (const t of Object.values(this.bodyTimers)) window.clearTimeout(t);
    window.clearTimeout(this.trimTimer);
    if (this.envIdleKind === 'ric') window.cancelIdleCallback?.(this.envIdle);
    else window.clearTimeout(this.envIdle);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) this.canvas.removeEventListener(ev, this.onInput);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.io?.disconnect();
    // Персонажи обоих тел (на сцене только один) и их геометрия
    for (const p of Object.values(this.characters)) p?.then((c) => c.dispose()).catch(() => {});
    this.scene.traverse((o) => {
      const l = o as THREE.SpotLight;
      if (l.isSpotLight) l.shadow.dispose();
    });
    this.mats.dispose();
    this.store.dispose();
    this.env?.dispose();
    this.shadowRT?.dispose();
    this.renderer.dispose();
    // Контекст освобождаем сразу, а не при сборке мусора: после ~16 живых контекстов Chrome
    // начинает отнимать самый старый («Too many active WebGL contexts»)
    this.renderer.forceContextLoss();
  }
}
