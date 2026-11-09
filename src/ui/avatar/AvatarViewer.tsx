// Центр экрана: V в полный рост из файлов игры, как в редакторе — живой персонаж,
// камера едет к выбранной части тела. Ассеты берутся из локальной выгрузки (/game/...).
// Если её нет или WebGL недоступен — показываем схематичный портрет.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CharacterState } from '../../model/state';
import type { AvatarEngine, SlotFocus } from './engine';
import { lookOf } from './look';

type Status = 'probe' | 'loading' | 'ready' | 'missing';

/** Как в игре: V стоит вполоборота в сторону списка настроек */
export const DEFAULT_YAW = 14;

let probePromise: Promise<boolean> | null = null;
/** Есть ли выгрузка игры: без неё 3D не грузим вовсе (three.js остаётся в отдельном чанке). */
const probe = () =>
  (probePromise ??= fetch('/game/hair/hint_meshes.json', { method: 'HEAD' })
    .then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('json'))
    .catch(() => false));

export default function AvatarViewer({
  state,
  focus,
  yaw,
  onYaw,
  fallback,
}: {
  state: CharacterState;
  /** выбранная строка каталога — от неё кадр камеры и поза V */
  focus: SlotFocus;
  yaw: number;
  onYaw: (deg: number) => void;
  fallback: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AvatarEngine | null>(null);
  const [status, setStatus] = useState<Status>('probe');
  const drag = useRef<{ x: number; yaw: number; id: number } | null>(null);
  const look = useMemo(() => lookOf(state), [state]);
  // Пока грузится чанк three.js, вид, кадр и угол могут измениться — движок стартует с последних
  const lookRef = useRef(look);
  lookRef.current = look;
  const yawRef = useRef(yaw);
  yawRef.current = yaw;
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    let alive = true;
    probe().then((ok) => alive && setStatus(ok ? 'loading' : 'missing'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (status === 'probe' || status === 'missing') return;
    const canvas = canvasRef.current;
    if (!canvas || engineRef.current) return;
    let engine: AvatarEngine | null = null;
    let ro: ResizeObserver | null = null;
    let offResize = () => {};
    let cancelled = false;
    import('./engine')
      .then(({ AvatarEngine }) => {
        if (cancelled) return;
        try {
          engine = new AvatarEngine(canvas);
        } catch {
          return setStatus('missing'); // нет WebGL
        }
        engineRef.current = engine;
        if (import.meta.env.DEV) (window as unknown as { __avatar?: AvatarEngine }).__avatar = engine;
        // V встаёт между колонкой типа тела и списком; в узкой раскладке колонок над ней нет
        const fit = () => {
          const w = canvas.clientWidth;
          const h = canvas.clientHeight;
          const c = canvas.getBoundingClientRect();
          const left = document.querySelector('.cc-left')?.getBoundingClientRect();
          const list = document.querySelector('.cc-list')?.getBoundingClientRect();
          const stacked = window.matchMedia('(max-width: 900px)').matches;
          const gl = !stacked && left ? Math.max(0, left.right - c.left) : 0;
          const gr = !stacked && list ? Math.min(w, list.left - c.left) : w;
          engine?.resize(w, h, gl, gr > gl ? gr : w);
        };
        ro = new ResizeObserver(fit);
        ro.observe(canvas);
        window.addEventListener('resize', fit);
        offResize = () => window.removeEventListener('resize', fit);
        fit();
        engine.setYaw(yawRef.current);
        engine.setFocus(focusRef.current);
        engine
          .setLook(lookRef.current)
          .then((ok) => !cancelled && ok && setStatus('ready'))
          .catch(() => !cancelled && setStatus('missing'));
      })
      .catch(() => setStatus('missing'));
    return () => {
      cancelled = true;
      ro?.disconnect();
      offResize();
      engine?.dispose();
      engineRef.current = null;
    };
    // Движок создаётся один раз после того, как выгрузка найдена; вид, кадр и угол обновляют эффекты ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status === 'probe' || status === 'missing']);

  useEffect(() => {
    engineRef.current
      ?.setLook(look)
      .then((ok) => ok && setStatus((s) => (s === 'loading' ? 'ready' : s)))
      .catch(() => setStatus('missing'));
  }, [look]);

  useEffect(() => {
    engineRef.current?.setFocus(focus);
  }, [focus.slotId, focus.group, focus.variantName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    engineRef.current?.setYaw(yaw);
  }, [yaw]);

  if (status === 'missing') return <>{fallback}</>;

  return (
    <div className="head" data-status={status}>
      <canvas
        ref={canvasRef}
        className="head-canvas"
        role="img"
        aria-label="3D-модель V с выбранными настройками. Перетащите, чтобы повернуть."
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, yaw, id: e.pointerId };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          onYaw(Math.max(-170, Math.min(170, d.yaw + (e.clientX - d.x) * 0.45)));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => onYaw(DEFAULT_YAW)}
      />
      {status !== 'ready' && (
        <div className="head-loading" role="status">
          <span>Загрузка модели V</span>
          <i />
        </div>
      )}
    </div>
  );
}
