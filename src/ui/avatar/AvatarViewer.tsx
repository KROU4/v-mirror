// Центр экрана: V в полный рост из файлов игры, как в редакторе — живой персонаж,
// камера едет к выбранной части тела. Файлы игры берутся из подключённого набора
// ассетов (src/assets/pack.ts). Пока набора нет или WebGL недоступен — показываем
// fallback (портрет и приглашение подключить набор), движок three.js не грузится вовсе.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getPackState, subscribePack } from '../../assets/pack';
import type { CharacterState } from '../../model/state';
import type { AvatarEngine, SlotFocus } from './engine';
import { lookOf } from './look';

/**
 * Что сейчас со сценой: набора нет (или выбрана не та папка — причину показывает панель
 * набора) / набор подключается / V грузится / V на сцене / ошибка сцены (нет WebGL, файлы
 * подключённого набора не читаются, контекст WebGL потерян и не вернулся).
 */
export type AvatarStatus = 'no-pack' | 'connecting' | 'loading' | 'ready' | 'error';

/** Как в игре: V стоит вполоборота в сторону списка настроек */
export const DEFAULT_YAW = 14;

/** Угол «по умолчанию», ближайший к текущему: сброс после нескольких оборотов не крутит V назад. */
export function nearestDefaultYaw(yaw: number): number {
  return DEFAULT_YAW + 360 * Math.round((yaw - DEFAULT_YAW) / 360);
}

/** Насколько можно отвернуть V от камеры, чтобы на крупном плане лицо ещё было видно. */
export const FACE_YAW_LIMIT = 60;

/**
 * Угол для крупного плана лица. Игра поворот куклы между разделами не сбрасывает, и малый
 * поворот остаётся; но после разворота на строке тела V на «Глазах» или «Губах» стояла в
 * профиль или спиной, лицо закрывали волосы — тогда она плавно возвращается к углу по умолчанию.
 */
export function faceYaw(yaw: number): number {
  const home = nearestDefaultYaw(yaw);
  return Math.abs(yaw - home) > FACE_YAW_LIMIT ? home : yaw;
}

const TEXT = {
  ru: {
    loading: 'Загрузка модели V',
    aria: '3D-модель V с выбранными настройками. Перетащите, чтобы повернуть.',
    lost: '3D-сцена остановилась (драйвер видеокарты её сбросил). Восстанавливаю…',
  },
  en: {
    loading: 'Loading V',
    aria: '3D model of V with the selected settings. Drag to rotate.',
    lost: 'The 3D view stopped (the graphics driver reset it). Restoring…',
  },
};
/** Сколько ждать, пока браузер вернёт потерянный контекст WebGL, прежде чем показать портрет. */
const CONTEXT_RESTORE_MS = 5000;

/** Время от начала загрузки страницы до первого кадра с V (performance mark). */
export const READY_MARK = 'avatar:ready';

export default function AvatarViewer({
  state,
  focus,
  yaw,
  onYaw,
  spin = 0,
  fallback,
  onStatus,
  lang = 'ru',
}: {
  state: CharacterState;
  /** выбранная строка каталога — от неё кадр камеры и поза V */
  focus: SlotFocus;
  /** угол поворота V, °, без ограничений (полный оборот) */
  yaw: number;
  onYaw: (deg: number) => void;
  /** −1 / 1 — V вращается, пока зажата Q или E; 0 — стоит */
  spin?: number;
  /** что показать без 3D (нет набора, нет WebGL, ошибка загрузки) */
  fallback: ReactNode;
  onStatus?: (s: AvatarStatus) => void;
  lang?: 'ru' | 'en';
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AvatarEngine | null>(null);
  /** снять движок текущего набора и показать ошибку сцены (общая уборка для всех путей ошибки) */
  const failRef = useRef<(() => void) | null>(null);
  const pack = useSyncExternalStore(subscribePack, getPackState, getPackState);
  // Движок пересоздаётся только когда сменился сам набор (packId): проверка другой папки,
  // отмена выбора или ошибка новой папки рабочий набор и V на сцене не трогают
  const packId = pack.status === 'ready' ? pack.packId ?? 0 : null;
  const [scene, setScene] = useState<{ pack: number | null; s: 'loading' | 'ready' | 'error' }>({ pack: null, s: 'loading' });
  const sceneState = packId !== null && scene.pack === packId ? scene.s : 'loading';
  const [lost, setLost] = useState(false);
  // Не та папка (pack.status 'error') — это «набора нет»: причину объясняет панель набора, а не сцена
  const status: AvatarStatus = packId === null ? (pack.status === 'connecting' ? 'connecting' : 'no-pack') : sceneState;
  const drag = useRef<{ x: number; yaw: number; id: number; cur: number } | null>(null);
  const look = useMemo(() => lookOf(state), [state]);
  // Пока грузится чанк three.js, вид, кадр и угол могут измениться — движок стартует с последних
  const lookRef = useRef(look);
  lookRef.current = look;
  const yawRef = useRef(yaw);
  yawRef.current = yaw;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    onStatusRef.current?.(status);
  }, [status]);

  // Время до первого кадра с V: одна метка, как бы V ни стала готова (первый вид или следующий)
  useEffect(() => {
    if (sceneState === 'ready' && !performance.getEntriesByName(READY_MARK).length) performance.mark(READY_MARK);
  }, [sceneState]);

  useEffect(() => {
    if (packId === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: AvatarEngine | null = null;
    let ro: ResizeObserver | null = null;
    let offResize = () => {};
    let cancelled = false;
    let lostTimer = 0;
    const mark = (s: 'loading' | 'ready' | 'error') => !cancelled && setScene({ pack: packId, s });
    mark('loading');
    import('./engine')
      .then(({ AvatarEngine }) => {
        if (cancelled) return;
        try {
          engine = new AvatarEngine(canvas, {
            onError: fail,
            // V нарисована с последним видом — в том числе когда вызов, которого ждал интерфейс,
            // вытеснен повторным надеванием после догрузки зубов и ногтей
            onShown: () => mark('ready'),
            // Контекст WebGL потерян (сброс драйвера, нехватка памяти): three восстановится сам,
            // если браузер вернёт контекст; не вернул за CONTEXT_RESTORE_MS — показываем портрет
            onContext: (state) => {
              if (cancelled) return;
              window.clearTimeout(lostTimer);
              setLost(state === 'lost');
              if (state === 'lost') lostTimer = window.setTimeout(fail, CONTEXT_RESTORE_MS);
            },
          });
        } catch {
          return mark('error'); // нет WebGL
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
          // На телефоне плашка описания лежит поверх низа сцены — кадр поднимается над ней
          const info = stacked ? document.querySelector('.cc-stage .info')?.getBoundingClientRect() : undefined;
          const inset = info && info.height > 0 ? Math.max(0, c.bottom - info.top) : 0;
          engine?.resize(w, h, gl, gr > gl ? gr : w, inset);
        };
        ro = new ResizeObserver(fit);
        ro.observe(canvas);
        const infoEl = document.querySelector('.cc-stage .info');
        if (infoEl) ro.observe(infoEl);
        window.addEventListener('resize', fit);
        offResize = () => window.removeEventListener('resize', fit);
        fit();
        engine.setYaw(yawRef.current);
        engine.setFocus(focusRef.current);
        engine
          .setLook(lookRef.current)
          .then((ok) => {
            if (!ok || cancelled) return;
            mark('ready');
          })
          .catch(fail);
      })
      .catch(fail);
    // Файлы набора не читаются: холст уходит, движок не должен рисовать в пустоту
    function fail() {
      // поздняя ошибка после смены набора: движок уже снят уборкой эффекта
      if (cancelled) return;
      window.clearTimeout(lostTimer);
      setLost(false);
      ro?.disconnect();
      ro = null;
      offResize();
      engine?.dispose();
      if (engineRef.current === engine) engineRef.current = null;
      engine = null;
      mark('error');
    }
    failRef.current = fail;
    return () => {
      cancelled = true;
      if (failRef.current === fail) failRef.current = null;
      window.clearTimeout(lostTimer);
      setLost(false);
      ro?.disconnect();
      offResize();
      engine?.dispose();
      if (engineRef.current === engine) engineRef.current = null;
      engine = null;
    };
    // Движок создаётся на каждое подключение набора; вид, кадр и угол обновляют эффекты ниже
  }, [packId]);

  useEffect(() => {
    const engine = engineRef.current;
    engine
      ?.setLook(look)
      .then((ok) => ok && setScene((s) => (s.s === 'loading' && s.pack === packId ? { pack: packId, s: 'ready' } : s)))
      .catch(() => {
        // та же уборка, что при ошибке первого вида: движок, наблюдатели размера, состояние сцены
        if (engineRef.current === engine) failRef.current?.();
      });
    // packId меняется вместе с движком — его эффект сам надевает последний вид
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look]);

  useEffect(() => {
    engineRef.current?.setFocus(focus);
  }, [focus.slotId, focus.group, focus.variantName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    engineRef.current?.setYaw(yaw);
  }, [yaw]);

  // Вращение клавишами считает движок; когда клавишу отпустили, угол возвращается в состояние
  const onYawRef = useRef(onYaw);
  onYawRef.current = onYaw;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setSpin(spin);
    if (!spin) onYawRef.current(engine.yawDeg);
  }, [spin]);

  const endDrag = (e: { pointerId: number }) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.cur !== d.yaw) onYaw(d.cur);
  };

  if (packId === null || sceneState === 'error') return <>{fallback}</>;

  const t = TEXT[lang] ?? TEXT.ru;
  return (
    <div className="head" data-status={sceneState}>
      {/* Свой холст на каждый набор: dispose() прошлого движка теряет контекст (forceContextLoss),
          и новый WebGLRenderer на том же холсте получил бы потерянный контекст */}
      <canvas
        key={packId}
        ref={canvasRef}
        className="head-canvas"
        role="img"
        aria-label={t.aria}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, yaw, id: e.pointerId, cur: yaw };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* указатель уже отпущен (перо, касание, синтетическое событие) */
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          // Во время перетаскивания угол идёт прямо в движок: перерисовка всего редактора на
          // каждое движение мыши удваивала время кадра. В состояние угол уходит, когда отпустили
          d.cur = d.yaw + (e.clientX - d.x) * 0.45;
          const engine = engineRef.current;
          if (engine) engine.setYaw(d.cur);
          else onYaw(d.cur);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => onYaw(nearestDefaultYaw(yaw))}
      />
      {(sceneState !== 'ready' || lost) && (
        <div className="head-loading" role="status">
          <span>{lost ? t.lost : t.loading}</span>
          <i />
        </div>
      )}
    </div>
  );
}
