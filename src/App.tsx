import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { displayNumber, type Gender, type Option } from './model/catalog';
import {
  decodeState,
  defaultState,
  encodeState,
  gameSheet,
  randomize,
  setValue,
  visibleSlots,
  type CharacterState,
  type VisibleSlot,
} from './model/state';
import { morphInfo, MORPH_SLOTS, type MorphSlot } from './model/descriptors';
import { LINES, LINE_OF_SLOT } from './ui/lines';
import Portrait from './ui/Portrait';
import type { ScanProvenance } from './scan/ScanPanel';
// Панель скана тянет MediaPipe и данные подбора — грузим её только при первом открытии
const ScanPanel = lazy(() => import('./scan/ScanPanel'));
import { hairLabel } from './model/hair';
import { browDescription } from './model/brows';
import { IconCheck, IconCopy, IconLeft, IconLink, IconReset, IconRight, IconScan, IconShuffle } from './ui/Icons';

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* приватный режим — работаем без сохранения */
    }
  },
};

function initialStates(): Record<Gender, CharacterState> {
  const fromHash = typeof location !== 'undefined' ? decodeState(new URLSearchParams(location.hash.slice(1)).get('v') ?? '') : null;
  const saved = store.get<Record<Gender, CharacterState> | null>('vm.states', null);
  const s = {
    male: saved?.male?.values ? saved.male : defaultState('male'),
    female: saved?.female?.values ? saved.female : defaultState('female'),
  };
  if (fromHash) s[fromHash.gender] = fromHash;
  return s;
}

const isMorph = (id: string): id is MorphSlot => (MORPH_SLOTS as string[]).includes(id);

export default function App() {
  const [states, setStates] = useState(initialStates);
  const [gender, setGender] = useState<Gender>(() => {
    const h = decodeState(new URLSearchParams(location.hash.slice(1)).get('v') ?? '');
    return h?.gender ?? store.get<Gender>('vm.gender', 'male');
  });
  // ?scan=1 — сразу открыть скан фото (ссылка «сделай V по фото»)
  const [mode, setMode] = useState<'edit' | 'scan'>(() =>
    new URLSearchParams(window.location.search).get('scan') === '1' ? 'scan' : 'edit',
  );
  const [current, setCurrent] = useState('skin_color');
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [prov, setProv] = useState<Record<string, ScanProvenance>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const state = states[gender];
  const slots = useMemo(() => visibleSlots(state), [state]);
  const sheet = useMemo(() => gameSheet(state), [state]);
  const cur = slots.find((s) => s.slot.id === current) ?? slots[0];

  useEffect(() => store.set('vm.states', states), [states]);
  useEffect(() => store.set('vm.gender', gender), [gender]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const update = useCallback(
    (next: CharacterState) => setStates((all) => ({ ...all, [next.gender]: next })),
    [],
  );

  const choose = useCallback(
    (vs: VisibleSlot, i: number) => {
      update(setValue(states[gender], vs.variant.name, i));
      setDone((d) => ({ ...d, [vs.slot.id]: false }));
    },
    [states, gender, update],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!cur) return;
      const opts = cur.variant.options;
      const pos = opts.findIndex((o) => o.i === cur.value);
      const next = opts[(pos + dir + opts.length) % opts.length];
      choose(cur, next.i);
    },
    [cur, choose],
  );

  const moveStation = useCallback(
    (dir: 1 | -1) => {
      if (!cur) return;
      const ids = slots.map((s) => s.slot.id);
      const pos = ids.indexOf(cur.slot.id);
      setCurrent(ids[Math.max(0, Math.min(ids.length - 1, pos + dir))]);
    },
    [cur, slots],
  );

  useEffect(() => {
    if (mode !== 'edit') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveStation(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveStation(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, step, moveStation]);

  const share = async () => {
    const url = `${location.origin}${location.pathname}#v=${encodeState(state)}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      flash('Ссылка на персонажа скопирована');
    } catch {
      flash('Ссылка в адресной строке — скопируйте её');
    }
  };

  const copySheet = async () => {
    const lines = [`V-MIRROR · ${gender === 'male' ? 'мужской' : 'женский'} V · Cyberpunk 2077 2.5`];
    for (const line of LINES) {
      const rows = sheet.filter((r) => LINE_OF_SLOT.get(r.slotId)?.id === line.id);
      if (!rows.length) continue;
      lines.push('', line.label.ru.toUpperCase());
      for (const r of rows) lines.push(`  ${r.label.ru}: ${r.number} из ${r.total}${r.value.ru && !/^\d+$/.test(r.value.ru) ? ` (${r.value.ru})` : ''}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      flash('Лист скопирован');
    } catch {
      flash('Не удалось скопировать — браузер запретил доступ к буферу');
    }
  };

  const applyScan = (next: CharacterState, provenance: Record<string, ScanProvenance>) => {
    update(next);
    setProv(provenance);
    setDone({});
    setMode('edit');
    flash('Подбор применён — проверьте маршрутный лист');
  };

  const lineStyle = (id: string) => ({ '--c': LINE_OF_SLOT.get(id)?.color ?? 'var(--ink-3)' }) as CSSProperties;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <b>V<span>-</span>MIRROR</b>
          <small>редактор V · Cyberpunk 2077 2.5</small>
        </div>
        <div className="seg" role="group" aria-label="Тело персонажа">
          {(['male', 'female'] as Gender[]).map((g) => (
            <button key={g} aria-pressed={gender === g} onClick={() => setGender(g)}>
              {g === 'male' ? 'Тип тела 1' : 'Тип тела 2'}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => { update(randomize(gender, 3)); setProv({}); }} title="Случайная внешность (обыденная)" aria-label="Случайно">
          <IconShuffle /> <span className="btn-label">Случайно</span>
        </button>
        <button className="btn ghost" onClick={() => { update(defaultState(gender)); setProv({}); setDone({}); }} title="Сбросить к значениям игры по умолчанию" aria-label="Сброс">
          <IconReset /> <span className="btn-label">Сброс</span>
        </button>
        <button className="btn ghost" onClick={share} title="Скопировать ссылку на эту V" aria-label="Ссылка">
          <IconLink /> <span className="btn-label">Ссылка</span>
        </button>
        <button className={`btn ${mode === 'scan' ? '' : 'primary'}`} onClick={() => setMode(mode === 'scan' ? 'edit' : 'scan')}>
          <IconScan /> {mode === 'scan' ? 'К редактору' : 'Скан фото'}
        </button>
      </header>

      <div className="workspace">
        <nav className="map" aria-label="Схема слотов редактора">
          {LINES.map((line) => {
            const items = slots.filter((s) => LINE_OF_SLOT.get(s.slot.id)?.id === line.id);
            if (!items.length) return null;
            return (
              <section key={line.id} className="map-line" style={{ '--c': line.color } as CSSProperties}>
                <h3>
                  <span className="line-badge">{line.code}</span>
                  {line.label.ru}
                </h3>
                <ul className="stations">
                  {items.map((vs) => {
                    const pv = prov[vs.slot.id];
                    const swatch = vs.option?.iris ?? vs.option?.hex;
                    return (
                      <li key={vs.slot.id}>
                        <button
                          className="station"
                          aria-current={mode === 'edit' && cur?.slot.id === vs.slot.id}
                          onClick={() => {
                            setCurrent(vs.slot.id);
                            setMode('edit');
                            // На телефоне редактор стоит над схемой — поднимаем к нему
                            if (window.matchMedia('(max-width: 760px)').matches) {
                              const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                              document.querySelector('.stage')?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
                            }
                          }}
                        >
                          {pv && <span className="scan-dot" style={{ width: 4 + pv.conf * 6, height: 4 + pv.conf * 6 }} title={`Подобрано (${pv.src})`} />}
                          <span>{vs.slot.label.ru}</span>
                          <span className={`val ${vs.value !== vs.variant.defaultIndex ? 'changed' : ''}`}>
                            {swatch && <i style={{ background: swatch }} />}
                            {String(displayNumber(vs.variant, vs.value)).padStart(2, '0')}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>

        <main className="stage">
          {mode === 'scan' ? (
            <Suspense fallback={<p className="muted">Загружаю модуль скана…</p>}>
              <ScanPanel gender={gender} base={state} onApply={applyScan} onGender={setGender} />
            </Suspense>
          ) : cur ? (
            <Editor vs={cur} state={state} onChoose={(i) => choose(cur, i)} onStep={step} style={lineStyle(cur.slot.id)} prov={prov[cur.slot.id]} />
          ) : null}
        </main>

        <aside className="sheet" aria-label="Маршрутный лист">
          <div className="sheet-head">
            <h2>Маршрутный лист</h2>
            <p>Выставьте эти номера в редакторе игры и отмечайте готовое. Номер — позиция варианта слева направо.</p>
            <div className="sheet-actions">
              <button className="btn" onClick={copySheet}>
                <IconCopy /> Копировать
              </button>
              <button className="btn ghost" onClick={() => setDone({})}>Снять отметки</button>
            </div>
          </div>
          <ol>
            {LINES.map((line) => {
              const rows = sheet.filter((r) => LINE_OF_SLOT.get(r.slotId)?.id === line.id);
              if (!rows.length) return null;
              return [
                <li key={line.id} className="group" style={{ '--c': line.color } as CSSProperties}>
                  {line.label.ru}
                </li>,
                ...rows.map((r) => (
                  <li key={r.slotId} className={done[r.slotId] ? 'done' : ''}>
                    <button
                      className="check"
                      role="checkbox"
                      aria-checked={!!done[r.slotId]}
                      aria-label={`${r.label.ru}: выставлено`}
                      onClick={() => setDone((d) => ({ ...d, [r.slotId]: !d[r.slotId] }))}
                    >
                      {done[r.slotId] && <IconCheck />}
                    </button>
                    <span className="name">
                      {r.label.ru}
                      {r.value.ru && !/^\d+$/.test(r.value.ru) && <small>{r.value.ru}</small>}
                    </span>
                    <span className="num">
                      {r.hex && <i style={{ background: r.hex }} />}
                      {r.number}
                      <small className="muted">/{r.total}</small>
                    </span>
                  </li>
                )),
              ];
            })}
          </ol>
        </aside>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function optionCaption(slotId: string, o: Option | undefined, gender: Gender): string {
  if (!o) return '';
  if (slotId === 'hairstyle') return hairLabel(o, gender);
  if (slotId === 'eyebrows') return browDescription(o)?.ru ?? '';
  if (isMorph(slotId)) return morphInfo(gender, slotId).options.find((m) => m.i === o.i)?.text.ru ?? '';
  const l = o.label.ru;
  return /^\d+$/.test(l) ? '' : l;
}

function Editor({
  vs,
  state,
  onChoose,
  onStep,
  style,
  prov,
}: {
  vs: VisibleSlot;
  state: CharacterState;
  onChoose: (i: number) => void;
  onStep: (d: 1 | -1) => void;
  style: CSSProperties;
  prov?: ScanProvenance;
}) {
  const line = LINE_OF_SLOT.get(vs.slot.id);
  const num = displayNumber(vs.variant, vs.value);
  const total = vs.variant.options.length;
  const hasSwatches = vs.variant.options.some((o) => o.hex || o.iris);
  const caption = optionCaption(vs.slot.id, vs.option, state.gender);
  return (
    <div style={style}>
      <div className="stage-head">
        <Portrait state={state} className="portrait" />
        <div className="sign">
          <div className="crumbs">
            <span className="line-badge" style={{ background: line?.color }}>{line?.code}</span>
            {line?.label.ru}
          </div>
          <h1>{vs.slot.label.ru}</h1>
          <div className="stop">
            <div className="stop-num" aria-live="polite">
              {String(num).padStart(2, '0')}
              <small>/ {total}</small>
            </div>
            <div className="stop-nav">
              <button className="btn" onClick={() => onStep(-1)} aria-label="Предыдущий вариант">
                <IconLeft />
              </button>
              <button className="btn" onClick={() => onStep(1)} aria-label="Следующий вариант">
                <IconRight />
              </button>
            </div>
          </div>
          <div className="stop-label">{caption ? <b>{caption}</b> : <span className="muted">Вариант {num}</span>}</div>
          <div className="hint">
            <span className="kbd">←</span> <span className="kbd">→</span> вариант · <span className="kbd">↑</span> <span className="kbd">↓</span> слот
          </div>
        </div>
      </div>

      <div className="grid" role="radiogroup" aria-label={vs.slot.label.ru}>
        {vs.variant.options.map((o, k) => {
          const sw = o.iris ?? o.hex;
          const isScan = prov && prov.value === o.i;
          return (
            <button
              key={o.i}
              role="radio"
              aria-checked={o.i === vs.value}
              className={`cell ${sw ? 'swatch' : ''}`}
              title={optionCaption(vs.slot.id, o, state.gender) || `Вариант ${k + 1}`}
              onClick={() => onChoose(o.i)}
            >
              {sw && <span className="sw" style={{ background: sw }} />}
              <span className="n">{k + 1}</span>
              {!sw && vs.slot.id === 'hairstyle' && o.tags[0] && <span className="tag">{tagRu(o.tags[0])}</span>}
              {isScan && <span className="pick" />}
            </button>
          );
        })}
      </div>

      {(prov || hasSwatches || isMorph(vs.slot.id)) && (
        <dl className="desc">
          {prov && (
            <>
              <dt>Подбор по фото</dt>
              <dd>
                Вариант {displayNumber(vs.variant, prov.value)} · {prov.src === 'llm' ? 'модель' : prov.src === 'local' ? 'измерение' : 'вручную'} · уверенность {Math.round(prov.conf * 100)}%
                {prov.why ? ` — ${prov.why}` : ''}
              </dd>
            </>
          )}
          {isMorph(vs.slot.id) && (
            <>
              <dt>Как измерено</dt>
              <dd>Описание варианта получено из смещений вершин 3D-головы V и рендера через детектор лица — так же анализируется ваше фото.</dd>
            </>
          )}
          {hasSwatches && (
            <>
              <dt>Цвет</dt>
              <dd>Образец — усреднённый цвет миниатюры из игры. В игре оттенок зависит от освещения.</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

function tagRu(t: string) {
  return ({ Buzz: 'ёжик', Short: 'корот', Long: 'длин', Dreads: 'дред', None: 'нет' } as Record<string, string>)[t] ?? t;
}
