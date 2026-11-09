// Центр экрана: 3D-голова V, как в редакторе игры. Меши берутся из локальной выгрузки
// игры (/game/...). Если её нет или WebGL недоступен — показываем схематичный портрет.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CharacterState } from '../model/state';
import { slotValue, visibleSlots } from '../model/state';
import type { HeadEngine, HeadLook } from './headEngine';

type Hints = Record<string, Record<string, string[]>>;
type Status = 'probe' | 'loading' | 'ready' | 'missing';

export const DEFAULT_YAW = -18;
let hintsPromise: Promise<Hints | null> | null = null;
const loadHints = () =>
  (hintsPromise ??= fetch('/game/hair/hint_meshes.json')
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<Hints>) : null))
    .catch(() => null));

function lookOf(state: CharacterState, hints: Hints | null): HeadLook {
  const val = (id: string) => slotValue(state, id);
  const morphs: string[] = [];
  for (const vs of visibleSlots(state)) {
    const m = vs.variant.type === 'morph' ? vs.option?.morph : undefined;
    if (m && m !== 'None') morphs.push(m);
  }
  const hs = val('hairstyle')?.option;
  const hint = Array.isArray(hs?.meshHint) ? hs?.meshHint[0] : hs?.meshHint;
  return {
    gender: state.gender,
    morphs,
    skin: val('skin_color')?.option?.hex,
    hair: val('hair_color')?.option?.hex,
    brows: val('eyebrows_color')?.option?.hex,
    iris: val('eyes_color')?.option?.iris ?? val('eyes_color')?.option?.hex,
    lashes: val('eyelash_color')?.option?.hex,
    hairMeshes: (hint && hints?.[state.gender]?.[hint]) || [],
  };
}

export default function HeadViewer({
  state,
  yaw,
  onYaw,
  fallback,
}: {
  state: CharacterState;
  yaw: number;
  onYaw: (deg: number) => void;
  fallback: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<HeadEngine | null>(null);
  const [status, setStatus] = useState<Status>('probe');
  const [hints, setHints] = useState<Hints | null>(null);
  const drag = useRef<{ x: number; yaw: number; id: number } | null>(null);
  const look = useMemo(() => lookOf(state, hints), [state, hints]);

  // Есть ли выгрузка игры: без неё 3D не грузим вовсе (three.js остаётся в отдельном чанке)
  useEffect(() => {
    let alive = true;
    loadHints().then((h) => {
      if (!alive) return;
      if (!h) return setStatus('missing');
      setHints(h);
      setStatus('loading');
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (status === 'probe' || status === 'missing') return;
    const canvas = canvasRef.current;
    if (!canvas || engineRef.current) return;
    let engine: HeadEngine | null = null;
    let ro: ResizeObserver | null = null;
    let cancelled = false;
    import('./headEngine')
      .then(({ HeadEngine }) => {
        if (cancelled) return;
        try {
          engine = new HeadEngine(canvas);
        } catch {
          return setStatus('missing'); // нет WebGL
        }
        engineRef.current = engine;
        const fit = () => engine?.resize(canvas.clientWidth, canvas.clientHeight);
        ro = new ResizeObserver(fit);
        ro.observe(canvas);
        fit();
        engine.setYaw(yaw);
        engine
          .setLook(look)
          .then(() => !cancelled && setStatus('ready'))
          .catch(() => !cancelled && setStatus('missing'));
      })
      .catch(() => setStatus('missing'));
    return () => {
      cancelled = true;
      ro?.disconnect();
      engine?.dispose();
      engineRef.current = null;
    };
    // Движок создаётся один раз после того, как выгрузка найдена; вид и угол обновляют эффекты ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status === 'probe' || status === 'missing']);

  useEffect(() => {
    engineRef.current?.setLook(look).catch(() => setStatus('missing'));
  }, [look]);

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
        aria-label="3D-модель головы V с выбранными настройками. Перетащите, чтобы повернуть."
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
          <span>Загрузка модели головы</span>
          <i />
        </div>
      )}
    </div>
  );
}
