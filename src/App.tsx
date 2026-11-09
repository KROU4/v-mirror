import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { displayNumber, GROUP_LABEL, type Gender, type Option } from './model/catalog';
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
import { pad2 } from './ui/format';
import Portrait from './ui/Portrait';
import HeadViewer, { DEFAULT_YAW } from './ui/HeadViewer';
import type { ScanProvenance } from './scan/ScanPanel';
// Панель скана тянет MediaPipe и данные подбора — грузим её только при первом открытии
const ScanPanel = lazy(() => import('./scan/ScanPanel'));
import { hairLabel } from './model/hair';
import { browDescription } from './model/brows';
import { IconArrow, IconCheck, IconClose, IconGrid, IconReset, IconScan, IconShuffle, IconTriLeft, IconTriRight } from './ui/Icons';

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
const swatchOf = (o: Option | undefined) => o?.iris ?? o?.hex;
const hasSwatches = (vs: VisibleSlot) => vs.variant.options.some((o) => o.hex || o.iris);
const BODY_LABEL: Record<Gender, string> = { male: 'Тип тела 1', female: 'Тип тела 2' };

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
  const [picker, setPicker] = useState(false);
  const [yaw, setYaw] = useState(DEFAULT_YAW);
  // Отметки «выставлено» и точки подбора по фото у каждого тела свои
  const [doneAll, setDoneAll] = useState<Record<Gender, Record<string, boolean>>>({ male: {}, female: {} });
  const [provAll, setProvAll] = useState<Record<Gender, Record<string, ScanProvenance>>>({ male: {}, female: {} });
  const done = doneAll[gender];
  const prov = provAll[gender];
  const setDone = useCallback(
    (g: Gender, v: SetStateAction<Record<string, boolean>>) => setDoneAll((a) => ({ ...a, [g]: typeof v === 'function' ? v(a[g]) : v })),
    [],
  );
  const setProv = useCallback(
    (g: Gender, v: Record<string, ScanProvenance>) => setProvAll((a) => ({ ...a, [g]: v })),
    [],
  );
  // Сканер, однажды открытый, остаётся смонтированным: выход из скана не теряет фото и ответ модели
  const [scanMounted, setScanMounted] = useState(mode === 'scan');
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLOListElement>(null);
  const kbdMove = useRef(false);

  const state = states[gender];
  const slots = useMemo(() => visibleSlots(state), [state]);
  const sheet = useMemo(() => gameSheet(state), [state]);
  const cur = slots.find((s) => s.slot.id === current) ?? slots[0];

  // Состояние из ссылки уже применено — убираем хеш, иначе перезагрузка затрёт последующие правки
  useEffect(() => {
    if (new URLSearchParams(location.hash.slice(1)).has('v')) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, []);

  useEffect(() => store.set('vm.states', states), [states]);
  useEffect(() => store.set('vm.gender', gender), [gender]);

  // Выбранная строка всегда видна в списке (стрелки ↑↓ листают его, как в игре). Листаем только
  // сам список: scrollIntoView на телефоне, где список не прокручивается, дёргал бы всю страницу
  useEffect(() => {
    const box = listRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-slot="${CSS.escape(cur?.slot.id ?? '')}"]`);
    const byKeys = kbdMove.current;
    kbdMove.current = false;
    if (!box || !el) return;
    if (box.scrollHeight <= box.clientHeight) {
      // Телефон: список — часть страницы. Листаем страницу только при ходе стрелками,
      // scroll-margin в CSS учитывает прилипшую сверху голову
      if (byKeys) el.scrollIntoView({ block: 'nearest' });
      return;
    }
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
  }, [cur?.slot.id]);

  const flash = useCallback((text: string, undo?: () => void) => {
    setToast({ text, undo });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 5000 : 2200);
  }, []);

  const update = useCallback(
    (next: CharacterState) => setStates((all) => ({ ...all, [next.gender]: next })),
    [],
  );

  /** Любая новая правка делает отмену массовой замены неактуальной — убираем кнопку. */
  const dropUndo = useCallback(() => setToast((t) => (t?.undo ? null : t)), []);

  const switchGender = useCallback(
    (g: Gender) => {
      if (g !== gender) {
        dropUndo();
        setPicker(false);
      }
      setGender(g);
    },
    [gender, dropUndo],
  );

  /** Массовая замена (Случайно, Сброс): запоминаем прежнее, чтобы вернуть одним нажатием. */
  const replaceAll = useCallback(
    (next: CharacterState, msg: string) => {
      const g = next.gender;
      const before = { state, prov, done };
      // Отметка «выставлено» снимается со строк, чей номер изменился
      const was = new Map(sheet.map((r) => [r.slotId, r.number]));
      const nextDone: Record<string, boolean> = {};
      for (const r of gameSheet(next)) if (done[r.slotId] && was.get(r.slotId) === r.number) nextDone[r.slotId] = true;
      update(next);
      setProv(g, {});
      setDone(g, nextDone);
      flash(msg, () => {
        update(before.state);
        setProv(g, before.prov);
        setDone(g, before.done);
        setToast(null);
      });
    },
    [state, prov, done, sheet, update, flash, setProv, setDone],
  );

  const shuffle = useCallback(
    () => replaceAll(randomize(gender, 3, Math.random, true, state), 'Лицо собрано случайно, тело не тронуто'),
    [replaceAll, gender, state],
  );

  const choose = useCallback(
    (vs: VisibleSlot, i: number) => {
      update(setValue(states[gender], vs.variant.name, i));
      setDone(gender, (d) => ({ ...d, [vs.slot.id]: false }));
      dropUndo();
    },
    [states, gender, update, dropUndo, setDone],
  );

  const stepRow = useCallback(
    (vs: VisibleSlot, dir: number) => {
      const opts = vs.variant.options;
      const pos = opts.findIndex((o) => o.i === vs.value);
      const next = opts[(((pos + dir) % opts.length) + opts.length) % opts.length];
      choose(vs, next.i);
    },
    [choose],
  );

  const curId = cur?.slot.id;
  /** Режим и сетка цветов меняются в одном месте: сетка живёт только в редакторе. */
  const goMode = useCallback((m: 'edit' | 'scan') => {
    setPicker(false);
    if (m === 'scan') setScanMounted(true);
    setMode(m);
  }, []);

  const select = useCallback(
    (id: string) => {
      // Сетка цветов принадлежит строке: при переходе на другую строку закрывается
      if (id !== curId) setPicker(false);
      // Клик по строке во время скана возвращает к редактору, как в прежней версии
      if (mode === 'scan') goMode('edit');
      setCurrent(id);
    },
    [curId, mode, goMode],
  );

  const moveRow = useCallback(
    (dir: 1 | -1) => {
      if (!cur) return;
      const ids = slots.map((s) => s.slot.id);
      const next = ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(cur.slot.id) + dir))];
      // На краю списка строка не меняется — флаг не взводим, иначе следующий клик дёрнет страницу
      if (next === cur.slot.id) return;
      kbdMove.current = true;
      select(next);
    },
    [cur, slots, select],
  );

  /** Закрыть сетку цветов и вернуть фокус на её кнопку в строке (×, Esc, двойной клик). */
  const closePicker = useCallback(() => {
    setPicker(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-slot="${CSS.escape(curId ?? '')}"] .ctrl-grid`)?.focus());
  }, [curId]);

  const share = useCallback(async () => {
    const url = `${location.origin}${location.pathname}#v=${encodeState(state)}`;
    try {
      await navigator.clipboard.writeText(url);
      flash('Ссылка на персонажа скопирована');
    } catch {
      // Буфер недоступен — кладём ссылку в адресную строку, чтобы её можно было скопировать вручную
      history.replaceState(null, '', url);
      flash('Ссылка в адресной строке — скопируйте её');
    }
  }, [state, flash]);

  const copySheet = useCallback(async () => {
    const lines = [`V-MIRROR · ${BODY_LABEL[gender].toLowerCase()} · Cyberpunk 2077 2.5`];
    for (const line of LINES) {
      const rows = sheet.filter((r) => LINE_OF_SLOT.get(r.slotId)?.id === line.id);
      if (!rows.length) continue;
      lines.push('', line.label.ru.toUpperCase());
      for (const r of rows) lines.push(`  ${r.label.ru}: ${pad2(r.number)} из ${pad2(r.total)}${r.value.ru && !/^\d+$/.test(r.value.ru) ? ` (${r.value.ru})` : ''}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      flash('Список настроек скопирован');
    } catch {
      flash('Не удалось скопировать — браузер запретил доступ к буферу');
    }
  }, [gender, sheet, flash]);

  const resetAll = useCallback(() => replaceAll(defaultState(gender), 'Все настройки сброшены к значениям игры'), [replaceAll, gender]);

  // Клавиши как в игре: ↑↓ строка, ←→ вариант, Q/E поворот головы; плюс R, C, L, G, Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        // Скан остаётся смонтированным, поэтому Esc закрывает его без потери фото и ответа модели
        if (picker && mode === 'edit') closePicker();
        else if (mode === 'scan') goMode('edit');
        return;
      }
      if (k === 'q' || k === 'й') return setYaw((y) => Math.max(-170, y - 20));
      if (k === 'e' || k === 'у') return setYaw((y) => Math.min(170, y + 20));
      if (mode !== 'edit' || !cur) return;
      const inPicker = t instanceof Element && !!t.closest('.picker-grid');
      if (e.key === 'ArrowRight') { e.preventDefault(); stepRow(cur, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepRow(cur, -1); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (inPicker) {
          const grid = (t as Element).closest('.picker-grid')!;
          const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
          stepRow(cur, dir * cols);
        } else moveRow(dir);
      } else if (k === 'r' || k === 'к') shuffle();
      else if (k === 'c' || k === 'с') copySheet();
      else if (k === 'l' || k === 'д') share();
      else if ((k === 'g' || k === 'п') && hasSwatches(cur)) setPicker((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, cur, picker, stepRow, moveRow, shuffle, copySheet, share, closePicker, goMode]);

  const applyScan = (next: CharacterState, provenance: Record<string, ScanProvenance>) => {
    update(next);
    setProv(next.gender, provenance);
    setDone(next.gender, {});
    goMode('edit');
    flash('Подбор применён — строки с точкой подобраны по фото');
  };

  let lastGroup = '';
  return (
    <div className="cc" data-mode={mode}>
      <div className="cc-frame" aria-hidden="true" />

      <div className="cc-proto" aria-hidden="true">
        <b>V-MIRROR</b>
        <span>Локальный редактор · данные из файлов игры 2.5 · номера совпадают с игрой</span>
      </div>

      <header className="cc-title">
        <h1>
          <span className="cc-chip" aria-hidden="true" />
          <span className="cc-bits" aria-hidden="true">
            0110001
            <br />
            0111000
            <br />
            0110000
            <br />
            0110101
          </span>
          <span className="cc-name">Выбор внешности Ви</span>
        </h1>
        <p>Выставьте эти номера в редакторе игры — и V будет такой же</p>
      </header>

      <aside className="cc-left" aria-label="Тип тела и действия">
        <h2>Тип тела</h2>
        <div className="bodies" role="group" aria-label="Тип тела">
          {(['male', 'female'] as Gender[]).map((g) => (
            <BodyCard key={g} g={g} active={gender === g} state={states[g]} onPick={() => switchGender(g)} />
          ))}
        </div>
        <div className="left-actions">
          <button className={`gbtn ${mode === 'scan' ? 'on' : 'accent'}`} onClick={() => goMode(mode === 'scan' ? 'edit' : 'scan')} aria-pressed={mode === 'scan'}>
            <IconScan /> {mode === 'scan' ? 'К редактору' : 'Скан фото'}
          </button>
          <button className="gbtn" onClick={resetAll}>
            <IconReset /> Сброс
          </button>
          <button className="gbtn shuffle" onClick={shuffle} title="Случайное лицо, тело не меняется">
            <kbd>R</kbd> Случайно
            <IconShuffle />
          </button>
        </div>
      </aside>

      <main className="cc-stage">
        <HeadViewer state={state} yaw={yaw} onYaw={setYaw} fallback={<Portrait state={state} className="portrait-fallback" />} />
        {scanMounted && (
          <section className="scan-wrap" aria-label="Скан фото" hidden={mode !== 'scan'}>
            <button className="scan-close" onClick={() => goMode('edit')} aria-label="Закрыть скан фото">
              <IconClose />
            </button>
            <Suspense fallback={<p className="muted">Загружаю модуль скана…</p>}>
              <ScanPanel gender={gender} base={state} onApply={applyScan} onGender={switchGender} />
            </Suspense>
          </section>
        )}
        {mode === 'edit' && cur && (
          <>
            <InfoBox vs={cur} gender={gender} prov={prov[cur.slot.id]} />
            {picker && hasSwatches(cur) && <Picker vs={cur} prov={prov[cur.slot.id]} onChoose={(i) => choose(cur, i)} onClose={closePicker} />}
          </>
        )}
      </main>

      <section className="cc-list" aria-label="Создание образа Ви">
        <h2>Создание образа Ви</h2>
        <ol className="rows" ref={listRef}>
          {slots.map((vs) => {
            const id = vs.slot.id;
            const sel = cur?.slot.id === id;
            const sw = hasSwatches(vs) ? swatchOf(vs.option) ?? '#000' : undefined;
            const pv = prov[id];
            const num = pad2(displayNumber(vs.variant, vs.value));
            const group = vs.slot.group;
            const showGroup = group !== lastGroup && lastGroup !== '';
            lastGroup = group;
            return [
              showGroup && (
                <li key={`g:${group}`} className="rows-group" aria-hidden="true">
                  {GROUP_LABEL[group].ru}
                </li>
              ),
              <li key={id} data-slot={id} className={`crow ${sel ? 'on' : ''} ${done[id] ? 'done' : ''}`}>
                <button
                  className="row-check"
                  role="checkbox"
                  aria-checked={!!done[id]}
                  aria-label={`${vs.slot.label.ru}: выставлено в игре`}
                  title="Отметить, что уже выставлено в игре"
                  onClick={() => {
                    setDone(gender, (d) => ({ ...d, [id]: !d[id] }));
                    dropUndo();
                  }}
                >
                  <span className="box">{done[id] && <IconCheck />}</span>
                </button>
                <button className="row-head" aria-current={sel} onClick={() => select(id)}>
                  <span className="row-label">{vs.slot.label.ru}</span>
                  {pv && <span className="row-scan" title={`Подобрано по фото (${pv.src === 'llm' ? 'модель' : 'замер'})`} />}
                  <span className="row-val">
                    <span className={sw ? 'row-num small' : 'row-num'}>{num}</span>
                    {sw && <i className="row-sw" style={{ background: sw }} />}
                  </span>
                </button>
                <div className="row-ctrl">
                  <button
                    aria-label={`${vs.slot.label.ru}: предыдущий вариант`}
                    onClick={() => {
                      select(id);
                      stepRow(vs, -1);
                    }}
                  >
                    <IconTriLeft />
                  </button>
                  {/* Как в игре: у строк без сетки средняя плашка пустая, стрелки стоят в одну колонку */}
                  {!sw && <span className="ctrl-gap" aria-hidden="true" />}
                  {sw && (
                    <button
                      className="ctrl-grid"
                      aria-label={`${vs.slot.label.ru}: все цвета`}
                      aria-expanded={sel && picker}
                      onClick={() => {
                        select(id);
                        setPicker((p) => (sel ? !p : true));
                      }}
                    >
                      <IconGrid />
                    </button>
                  )}
                  <button
                    aria-label={`${vs.slot.label.ru}: следующий вариант`}
                    onClick={() => {
                      select(id);
                      stepRow(vs, 1);
                    }}
                  >
                    <IconTriRight />
                  </button>
                </div>
              </li>,
            ];
          })}
        </ol>
        <div className="list-actions">
          <button className="gbtn" onClick={copySheet}>
            <kbd>C</kbd> Копировать список
          </button>
          <button className="gbtn" onClick={share}>
            <kbd>L</kbd> Ссылка
          </button>
        </div>
      </section>

      <footer className="cc-foot" aria-label="Управление">
        <span>
          <kbd>Q</kbd> Повернуть <kbd>E</kbd>
        </span>
        <span>
          <kbd aria-label="Вверх"><IconArrow dir="up" /></kbd>
          <kbd aria-label="Вниз"><IconArrow dir="down" /></kbd> Выбрать
        </span>
        <span>
          <kbd aria-label="Влево"><IconArrow dir="left" /></kbd>
          <kbd aria-label="Вправо"><IconArrow dir="right" /></kbd> Изменить
        </span>
        <span className="foot-g">
          <kbd>G</kbd> Сетка цветов
        </span>
      </footer>

      <div className="toast-host" role="status" aria-live="polite">
        {toast && (
          <div className="toast">
            <span>{toast.text}</span>
            {toast.undo && (
              <button className="toast-undo" onClick={toast.undo}>
                Отменить
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BodyCard({ g, active, state, onPick }: { g: Gender; active: boolean; state: CharacterState; onPick: () => void }) {
  const [noImg, setNoImg] = useState(false);
  return (
    <button className="body-card" aria-pressed={active} onClick={onPick} aria-label={BODY_LABEL[g]}>
      {noImg ? (
        <Portrait state={state} className="body-img" />
      ) : (
        <img className="body-img" src={`/game/renders/${g}/base.png`} alt="" onError={() => setNoImg(true)} />
      )}
      <span className="body-tag" aria-hidden="true">
        {BODY_LABEL[g]}
      </span>
    </button>
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

function InfoBox({ vs, gender, prov }: { vs: VisibleSlot; gender: Gender; prov?: ScanProvenance }) {
  const caption = optionCaption(vs.slot.id, vs.option, gender);
  return (
    <div className="info" aria-live="polite">
      <div className="info-head">
        <span>{vs.slot.label.ru}</span>
        <b>
          {pad2(displayNumber(vs.variant, vs.value))}
          <small> / {pad2(vs.variant.options.length)}</small>
        </b>
      </div>
      {caption && <p>{caption}</p>}
      {prov && (
        <p className="info-prov">
          По фото: вариант {pad2(displayNumber(vs.variant, prov.value))} · {prov.src === 'llm' ? 'модель' : prov.src === 'local' ? 'замер' : 'вручную'} · уверенность {Math.round(prov.conf * 100)}%
          {prov.why ? ` — ${prov.why}` : ''}
        </p>
      )}
    </div>
  );
}

function Picker({ vs, prov, onChoose, onClose }: { vs: VisibleSlot; prov?: ScanProvenance; onChoose: (i: number) => void; onClose: () => void }) {
  const gridRef = useRef<HTMLDivElement>(null);
  // Фокус идёт за выбранной ячейкой: при открытии и при смене варианта стрелками
  useEffect(() => {
    const g = gridRef.current;
    if (!g) return;
    const a = document.activeElement;
    if ((!a || a === document.body || g.contains(a)) && a?.getAttribute('aria-checked') !== 'true') {
      g.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    }
  }, [vs.value]);
  useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [vs.slot.id]);
  return (
    <div className="picker" role="dialog" aria-label={`${vs.slot.label.ru}: выбор цвета`}>
      <div className="picker-head">
        <span>{vs.slot.label.ru}</span>
        <button onClick={onClose} aria-label="Закрыть сетку цветов">
          <IconClose />
        </button>
      </div>
      <div className="picker-grid" role="radiogroup" aria-label={vs.slot.label.ru} ref={gridRef}>
        {vs.variant.options.map((o, k) => {
          const sw = swatchOf(o) ?? '#000';
          return (
            <button
              key={o.i}
              role="radio"
              aria-checked={o.i === vs.value}
              tabIndex={o.i === vs.value ? 0 : -1}
              aria-label={`${pad2(k + 1)}${o.label.ru && !/^\d+$/.test(o.label.ru) ? ` — ${o.label.ru}` : ''}`}
              className="cell"
              onClick={() => onChoose(o.i)}
              onDoubleClick={onClose}
            >
              <span className="sw" style={{ background: sw }} />
              <span className="n">{pad2(k + 1)}</span>
              {prov?.value === o.i && <span className="pick" title="Подобрано по фото" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
