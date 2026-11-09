// Клипы тела из ui_*.anims игры (body/anim/ui_<g>.glb) на общем скелете:
// повороты всех костей, смещение только у Root и Hips (остальные смещения рига
// анимации на пару сантиметров отличаются от привязки меша), без масштаба.
import * as THREE from 'three';
import type { MasterSkeleton } from './skeleton';
import { clipPlan, type BodyMode, type ClipStep } from './slots';

const DROP = new Set(['Trajectory', 'reference_joint', 'WeaponLeft', 'WeaponRight']);
const FADE = 0.5;

/** Оставить в клипе только то, что можно применить к скелету меша. */
export function filterClip(clip: THREE.AnimationClip, sk: MasterSkeleton): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => {
    const dot = t.name.lastIndexOf('.');
    const node = t.name.slice(0, dot);
    const prop = t.name.slice(dot + 1);
    if (DROP.has(node) || !sk.bones.has(node)) return false;
    if (prop === 'quaternion') return true;
    if (prop === 'position') return node === 'Root' || node === 'Hips';
    return false;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

export class BodyAnimator {
  private mixer: THREE.AnimationMixer;
  private clips = new Map<string, THREE.AnimationClip>();
  private current: THREE.AnimationAction | null = null;
  private queue: ClipStep[] = [];
  private mode: BodyMode | null = null;
  private pending: { mode: BodyMode; showcase: string | null } | null = null;

  constructor(root: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', (e) => {
      if ((e as unknown as { action: THREE.AnimationAction }).action === this.current) this.advance();
    });
  }

  get ready() {
    return this.clips.size > 0;
  }

  setClips(clips: THREE.AnimationClip[], sk: MasterSkeleton) {
    for (const c of clips) this.clips.set(c.name, filterClip(c, sk));
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.mode = null; // клипы пришли только сейчас: начинаем сразу с цикла, без переходов
      this.request(p.mode, p.showcase);
    }
  }

  /** Перейти в позу (крупный план / рост / рука), при необходимости через клипы-переходы. */
  request(mode: BodyMode, showcase: string | null) {
    if (!this.ready) {
      this.pending = { mode, showcase };
      return;
    }
    if (mode === this.mode && !showcase) return;
    const plan = clipPlan(this.mode, mode, showcase).filter((s) => this.clips.has(s.clip));
    this.mode = mode;
    if (!plan.length) return;
    this.queue = plan;
    this.advance();
  }

  private advance(): void {
    const step = this.queue.shift();
    if (!step) return;
    const clip = this.clips.get(step.clip);
    if (!clip) return this.advance();
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(step.loop ? THREE.LoopRepeat : THREE.LoopOnce, step.loop ? Infinity : 1);
    action.clampWhenFinished = !step.loop;
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.play();
    if (this.current && this.current !== action) this.current.crossFadeTo(action, FADE, false);
    this.current = action;
  }

  update(dt: number) {
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}
