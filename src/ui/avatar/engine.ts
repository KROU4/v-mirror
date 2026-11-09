// 3D-персонаж V из файлов игры: рендерер, сцена редактора, цикл кадров.
// Модуль грузится лениво (отдельный чанк с three.js) и только когда выгрузка есть.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Gender } from '../../model/catalog';
import { AssetStore } from './assets';
import { Character } from './character';
import type { AvatarLook } from './look';
import { Materials } from './materials';
import { bodyModeFor, cameraShot, cameraSlotFor, showcaseClipFor, type CameraSlot } from './slots';
import { CameraRig, LightRig } from './stage';

export type { AvatarLook } from './look';

export interface SlotFocus {
  slotId?: string;
  group?: string;
  variantName?: string;
}

export class AvatarEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private rig = new CameraRig();
  private lights = new LightRig();
  private store = new AssetStore();
  private mats: Materials;
  private env: THREE.Texture;
  private characters: Partial<Record<Gender, Promise<Character>>> = {};
  private active: Character | null = null;
  private stageGroup = new THREE.Group();
  private token = 0;
  private hairToken = 0;
  private lastLook: AvatarLook | null = null;
  private slot: CameraSlot = 'UI_Skin';
  private yawTarget = 0;
  private yaw = 0;
  private raf = 0;
  private last = performance.now();
  private visible = !document.hidden;
  disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Экспозиция в игре фиксированная (automated 0)
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.store.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    // Очень слабое нейтральное окружение — только для бликов глаз, зубов и ногтей
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.mats = new Materials(this.store, this.env);
    this.scene.add(this.lights.group, this.stageGroup);
    this.rig.camera.updateProjectionMatrix();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.loop();
  }

  private onVisibility = () => {
    this.visible = !document.hidden;
    if (this.visible) {
      this.last = performance.now(); // после паузы не прыгаем на всё пропущенное время
      this.loop();
    }
  };

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.frame(dt);
  };

  private frame(dt: number) {
    this.rig.update(dt);
    // Инерция поворота, как yawSpeed у куклы в игре
    this.yaw += (this.yawTarget - this.yaw) * (1 - Math.exp(-dt * 8));
    const ch = this.active;
    if (ch) {
      ch.root.rotation.y = THREE.MathUtils.degToRad(this.yaw);
      ch.root.updateMatrixWorld(true);
      ch.update(dt, this.rig.camera.position);
    }
    this.renderer.render(this.scene, this.rig.camera);
  }

  private characterFor(g: Gender): Promise<Character> {
    let p = this.characters[g];
    if (!p) {
      p = Character.build(g, this.store, this.mats);
      p.catch(() => delete this.characters[g]);
      this.characters[g] = p;
    }
    return p;
  }

  /**
   * Надеть вид. Последний вызов побеждает. true — V этого вызова на сцене
   * (false — вызов вытеснен следующим). Причёска догружается после.
   */
  async setLook(look: AvatarLook): Promise<boolean> {
    const my = ++this.token;
    this.lastLook = look;
    const ch = await this.characterFor(look.gender);
    if (this.disposed || my !== this.token) return false;
    const apply = await ch.prepare(look);
    if (this.disposed || my !== this.token) return false;
    if (this.active !== ch) {
      if (this.active) this.stageGroup.remove(this.active.root);
      this.stageGroup.add(ch.root);
      this.active = ch;
      this.lights.setGender(look.gender);
      this.applySlot(true);
    }
    apply();
    this.updateHair(look);
    // Зубы, ногти и клипы тела — фоном; когда придут, вид надевается ещё раз
    ch.loadExtras(() => {
      if (!this.disposed && this.active === ch && this.lastLook) this.setLook(this.lastLook);
    });
    return true;
  }

  private async updateHair(look: AvatarLook) {
    const my = ++this.hairToken;
    const ch = this.active;
    if (!ch) return;
    try {
      const apply = await ch.prepareHair(look);
      if (this.disposed || my !== this.hairToken || this.active !== ch) return;
      apply();
    } catch {
      /* причёска не загрузилась — V остаётся без неё */
    }
  }

  /** Выбранная строка каталога: кадр камеры и поза. */
  setFocus(f: SlotFocus) {
    const slot = cameraSlotFor(f.slotId, f.group, f.variantName);
    if (slot === this.slot) return;
    this.slot = slot;
    this.applySlot(false);
  }

  private applySlot(immediate: boolean) {
    const ch = this.active;
    if (!ch) return;
    this.rig.setShot(cameraShot(this.slot, ch.gender), immediate);
    ch.anim.request(bodyModeFor(this.slot), showcaseClipFor(this.slot));
    ch.face.teethTarget = this.slot === 'UI_Teeth' ? 1 : 0;
  }

  setYaw(deg: number) {
    this.yawTarget = deg;
  }

  /**
   * gapLeft..gapRight — видимый промежуток холста между колонками интерфейса (в пикселях
   * холста). Персонаж встаёт в его середину и уменьшается, если промежуток узкий.
   */
  resize(w: number, h: number, gapLeft = 0, gapRight = w) {
    if (w < 1 || h < 1) return;
    this.renderer.setSize(w, h, false);
    const cam = this.rig.camera;
    cam.aspect = w / h;
    const gap = Math.max(1, gapRight - gapLeft);
    cam.zoom = Math.min(1, (gap / h) * 1.3);
    const center = (gapLeft + gapRight) / 2 / w;
    cam.setViewOffset(w, h, (0.5 - center) * w, 0, w, h);
    cam.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    this.token++;
    this.hairToken++;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    // Персонажи обоих тел (на сцене только один) и их геометрия
    for (const p of Object.values(this.characters))
      p?.then((c) => {
        c.root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.geometry.dispose();
        });
        c.dispose();
      }).catch(() => {});
    this.scene.traverse((o) => {
      const l = o as THREE.SpotLight;
      if (l.isSpotLight) l.shadow.dispose();
    });
    this.mats.dispose();
    this.store.dispose();
    this.env.dispose();
    this.renderer.dispose();
  }
}
