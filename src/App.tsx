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
import AvatarViewer, { DEFAULT_YAW, faceYaw, yawForRow, type AvatarStatus } from './ui/avatar/AvatarViewer';
import { notIn3d, type PackPart } from './ui/avatar/look';
import { isCloseupFocus } from './ui/avatar/slots';
import type { ScanProvenance } from './scan/ScanPanel';
import { hairDescription } from './model/hair';
import { browDescription } from './model/brows';
import { LANGS, useI18n, type Lang, type T } from './i18n';
import { slotHasSwatches, Swatch, usePackState } from './ui/SwatchChip';
import { PackConnect, PackHero, portraitUrl } from './ui/PackPanel';
import Modal from './ui/Modal';
import KeyPanel from './scan/KeyPanel';
import { useOrSettings } from './scan/openrouter';
import {
  IconArrow,
  IconBust,
  IconCheck,
  IconClose,
  IconCube,
  IconGrid,
  IconKey,
  IconReset,
  IconScan,
  IconShuffle,
  IconTriLeft,
  IconTriRight,
} from './ui/Icons';

// Панель скана тянет MediaPipe и данные подбора — грузим её только при первом открытии
const ScanPanel = lazy(() => import('./scan/ScanPanel'));

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
/** Тип тела в игре — две плитки по порядку; подпись говорит, какое тело, номер — как в игре. */
const BODY_N: Record<Gender, string> = { male: '01', female: '02' };
const bodyName = (g: Gender, t: T) => t(g === 'male' ? 'body.male' : 'body.female');
const srcName = (src: ScanProvenance['src'], t: T) => t(src === 'llm' ? 'src.llm' : src === 'local' ? 'src.local' : 'src.manual');

type Dialog = 'pack' | 'key' | null;

export default function App() {
  const { lang, t, loc, setLang } = useI18n();
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
  /** Q/E: V вращается, пока клавиша зажата (как в игре), без ограничения угла */
  const [spin, setSpin] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  // ?pack=1: opened by the PowerShell one-liner right after it built the pack
  const [packAsk, setPackAsk] = useState(() => new URLSearchParams(window.location.search).get('pack') === '1');
  const packAutoOpened = useRef(false);
  const packNow = usePackState();
  const [avatar, setAvatar] = useState<AvatarStatus>('no-pack');
  // Части набора, которых в нём нет (набор собран старой версией): их строки помечаются «не в 3D»
  const [missing3d, setMissing3d] = useState<ReadonlySet<PackPart>>(() => new Set());
  const onMissing = useCallback((parts: PackPart[]) => setMissing3d(new Set(parts)), []);
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
  // Кадр камеры и поза V — по выбранной строке, как в редакторе игры
  const focus = useMemo(
    () => ({ slotId: cur?.slot.id, group: cur?.slot.group, variantName: cur?.variant.name }),
    [cur?.slot.id, cur?.slot.group, cur?.variant.name],
  );
  const curHasSw = !!cur && slotHasSwatches(gender, cur.slot.id, cur.variant);
  // Переход на крупный план лица: V, развёрнутая в профиль или спиной, поворачивается к камере
  const closeup = isCloseupFocus(focus.slotId, focus.group, focus.variantName);
  // Шрамы тела на спине: на их строке V поворачивается спиной, на следующей строке — обратно
  const prevRow = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevRow.current;
    prevRow.current = focus.slotId;
    if (closeup) setYaw((y) => faceYaw(y));
    else if (prev !== focus.slotId) setYaw((y) => yawForRow(y, prev, focus.slotId));
  }, [closeup, focus.slotId]);

  // Состояние из ссылки уже применено — убираем хеш, иначе перезагрузка затрёт последующие правки
  useEffect(() => {
    if (new URLSearchParams(location.hash.slice(1)).has('v')) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, []);

  // ?pack=1 and no pack yet: open the pack panel with the folder button marked. Once a pack is
  // connected the parameter is dropped (a reload does not reopen it) and the panel closes.
  useEffect(() => {
    if (!packAsk || packNow.status === 'connecting' || packNow.busy) return;
    if (packNow.status === 'ready') {
      if (packAutoOpened.current) setDialog((d) => (d === 'pack' ? null : d));
      const q = new URLSearchParams(location.search);
      q.delete('pack');
      const qs = q.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
      setPackAsk(false);
      return;
    }
    if (!packAutoOpened.current) {
      packAutoOpened.current = true;
      setDialog('pack');
    }
  }, [packAsk, packNow.status, packNow.busy]);

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
    // сверху список затухает (--rows-fade): строка встаёт ниже затухания
    const fade = parseFloat(getComputedStyle(box).paddingTop) || 0;
    if (r.top < b.top + fade) box.scrollTop -= b.top + fade - r.top + 8;
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
  const dropUndo = useCallback(() => setToast((x) => (x?.undo ? null : x)), []);

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
    () => replaceAll(randomize(gender, 3, Math.random, true, state), t('toast.random')),
    [replaceAll, gender, state, t],
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
      flash(t('toast.linkCopied'));
    } catch {
      // Буфер недоступен — кладём ссылку в адресную строку, чтобы её можно было скопировать вручную
      history.replaceState(null, '', url);
      flash(t('toast.linkInBar'));
    }
  }, [state, flash, t]);

  const copySheet = useCallback(async () => {
    const lines = [t('sheet.head', { n: BODY_N[gender], name: bodyName(gender, t).toLowerCase() })];
    for (const line of LINES) {
      const rows = sheet.filter((r) => LINE_OF_SLOT.get(r.slotId)?.id === line.id);
      if (!rows.length) continue;
      lines.push('', loc(line.label).toUpperCase());
      for (const r of rows) {
        const v = loc(r.value);
        lines.push(`  ${t('sheet.row', { label: loc(r.label), n: pad2(r.number), total: pad2(r.total) })}${v && !/^\d+$/.test(v) ? ` (${v})` : ''}`);
      }
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      flash(t('toast.listCopied'));
    } catch {
      flash(t('toast.copyFailed'));
    }
  }, [gender, sheet, flash, t, loc]);

  const resetAll = useCallback(() => replaceAll(defaultState(gender), t('toast.reset')), [replaceAll, gender, t]);

  /** Отметка «выставлено в игре» у выбранной строки (кнопка в описании варианта или X). */
  const toggleDone = useCallback(() => {
    if (!curId) return;
    setDone(gender, (d) => ({ ...d, [curId]: !d[curId] }));
    dropUndo();
  }, [curId, gender, setDone, dropUndo]);
  const doneCount = slots.filter((s) => done[s.slot.id]).length;

  // Клавиши как в игре: ↑↓ строка, ←→ вариант, Q/E поворот головы; плюс R, C, L, G, Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (tg instanceof Element && tg.closest('input, textarea, select, [contenteditable="true"]')) return;
      // Открытое окно (ассеты, ключ) — клавиши редактора не работают, Esc закрывает окно само
      if (document.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        // Скан остаётся смонтированным, поэтому Esc закрывает его без потери фото и ответа модели
        if (picker && mode === 'edit') closePicker();
        else if (mode === 'scan') goMode('edit');
        return;
      }
      if (k === 'q' || k === 'й' || k === 'e' || k === 'у') {
        e.preventDefault();
        return setSpin(k === 'q' || k === 'й' ? -1 : 1);
      }
      if (mode !== 'edit' || !cur) return;
      const inPicker = tg instanceof Element && !!tg.closest('.picker-grid');
      if (e.key === 'ArrowRight') { e.preventDefault(); stepRow(cur, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepRow(cur, -1); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (inPicker) {
          const grid = (tg as Element).closest('.picker-grid')!;
          const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
          stepRow(cur, dir * cols);
        } else moveRow(dir);
      } else if (k === 'r' || k === 'к') shuffle();
      else if (k === 'c' || k === 'с') copySheet();
      else if (k === 'l' || k === 'д') share();
      else if (k === 'x' || k === 'ч') toggleDone();
      else if ((k === 'g' || k === 'п') && curHasSw) setPicker((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, cur, curHasSw, picker, stepRow, moveRow, shuffle, copySheet, share, closePicker, goMode, toggleDone]);

  useEffect(() => {
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'q' || k === 'й') setSpin((s) => (s < 0 ? 0 : s));
      else if (k === 'e' || k === 'у') setSpin((s) => (s > 0 ? 0 : s));
    };
    const stop = () => setSpin(0);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', stop);
    };
  }, []);

  const applyScan = (next: CharacterState, provenance: Record<string, ScanProvenance>) => {
    update(next);
    setProv(next.gender, provenance);
    setDone(next.gender, {});
    goMode('edit');
    flash(t('toast.applied'));
  };

  const closeDialog = useCallback(() => setDialog(null), []);

  let lastGroup = '';
  return (
    <div className="cc" data-mode={mode} data-avatar={avatar}>
      <div className="cc-frame" aria-hidden="true" />

      <div className="cc-proto" aria-hidden="true">
        <b>V-MIRROR</b>
        {/* the separator dot starts a line, never ends one */}
        <span>{t('proto.text').replace(/ · /g, ' · ')}</span>
      </div>

      <UtilBar lang={lang} setLang={setLang} onPack={() => setDialog('pack')} onKey={() => setDialog('key')} />

      <header className="cc-title" data-closeup={closeup || undefined}>
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
          <span className="cc-name">{t('title.name')}</span>
        </h1>
        <p>{t('title.sub')}</p>
      </header>

      <aside className="cc-left" aria-label={t('left.aria')}>
        <h2>{t('left.title')}</h2>
        <div className="bodies" role="group" aria-label={t('left.title')}>
          {(['male', 'female'] as Gender[]).map((g) => (
            <BodyCard key={g} g={g} active={gender === g} onPick={() => switchGender(g)} />
          ))}
        </div>
        <div className="left-actions">
          <button className={`gbtn ${mode === 'scan' ? 'on' : 'accent'}`} onClick={() => goMode(mode === 'scan' ? 'edit' : 'scan')} aria-pressed={mode === 'scan'}>
            <IconScan /> {mode === 'scan' ? t('act.back') : t('act.scan')}
          </button>
          <button className="gbtn" onClick={resetAll}>
            <IconReset /> {t('act.reset')}
          </button>
          <button className="gbtn shuffle" onClick={shuffle} title={t('act.randomTitle')}>
            <kbd>R</kbd> {t('act.random')}
            <IconShuffle />
          </button>
        </div>
      </aside>

      <main className="cc-stage">
        <AvatarViewer
          state={state}
          focus={focus}
          yaw={yaw}
          onYaw={setYaw}
          spin={spin}
          lang={lang}
          onStatus={setAvatar}
          onMissing={onMissing}
          fallback={<PackHero gender={gender} state={state} webglError={avatar === 'error'} onMore={() => setDialog('pack')} highlight={packAsk} />}
        />
        {scanMounted && (
          <section className="scan-wrap" aria-label={t('scan.aria')} hidden={mode !== 'scan'}>
            <button className="scan-close" onClick={() => goMode('edit')} aria-label={t('scan.close')}>
              <IconClose />
            </button>
            <Suspense
              fallback={
                <div className="scan-loading" role="status">
                  <span>{t('scan.loading')}</span>
                  <i />
                </div>
              }
            >
              <ScanPanel active={mode === 'scan'} gender={gender} base={state} in3d={avatar === 'ready' || avatar === 'loading'} missing3d={missing3d} onApply={applyScan} onGender={switchGender} onKeySettings={() => setDialog('key')} />
            </Suspense>
          </section>
        )}
        {mode === 'edit' && cur && (
          <>
            <InfoBox vs={cur} gender={gender} in3d={avatar === 'ready' || avatar === 'loading'} missing3d={missing3d} prov={prov[cur.slot.id]} done={!!done[cur.slot.id]} onDone={toggleDone} doneCount={doneCount} total={slots.length} />
            {picker && curHasSw && <Picker vs={cur} gender={gender} prov={prov[cur.slot.id]} onChoose={(i) => choose(cur, i)} onClose={closePicker} />}
          </>
        )}
      </main>

      <section className="cc-list" aria-label={t('list.title')}>
        <h2>{t('list.title')}</h2>
        <ol className="rows" ref={listRef}>
          {slots.map((vs) => {
            const id = vs.slot.id;
            const sel = cur?.slot.id === id;
            const hasSw = slotHasSwatches(gender, id, vs.variant);
            const pv = prov[id];
            const num = pad2(displayNumber(vs.variant, vs.value));
            const label = loc(vs.slot.label);
            const group = vs.slot.group;
            const showGroup = group !== lastGroup && lastGroup !== '';
            lastGroup = group;
            return [
              showGroup && (
                <li key={`g:${group}`} className="rows-group" aria-hidden="true">
                  {loc(GROUP_LABEL[group])}
                </li>
              ),
              <li key={id} data-slot={id} className={`crow ${sel ? 'on' : ''} ${done[id] ? 'done' : ''}`}>
                <button className="row-head" aria-current={sel} onClick={() => select(id)}>
                  <span className="row-label">
                    {label}
                    {done[id] && <span className="vh">{t('row.done')}</span>}
                  </span>
                  {pv && <span className="row-scan" title={t('row.scanned', { src: srcName(pv.src, t) })} />}
                  <span className="row-val">
                    {done[id] && <IconCheck className="row-done" />}
                    <span className={hasSw ? 'row-num small' : 'row-num'}>{num}</span>
                    {hasSw && <Swatch gender={gender} slotId={id} option={vs.option} className="row-sw" />}
                  </span>
                </button>
                {/* Стрелки дублируют клавиши ←→ выбранной строки, поэтому Tab идёт по строкам, а не по 90 клеткам */}
                <div className="row-ctrl">
                  <button
                    tabIndex={-1}
                    aria-label={t('row.prev', { slot: label })}
                    onClick={() => {
                      select(id);
                      stepRow(vs, -1);
                    }}
                  >
                    <IconTriLeft />
                  </button>
                  {/* Как в игре: у строк без сетки средняя плашка пустая, стрелки стоят в одну колонку */}
                  {!hasSw && <span className="ctrl-gap" aria-hidden="true" />}
                  {hasSw && (
                    <button
                      className="ctrl-grid"
                      aria-label={t('row.grid', { slot: label })}
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
                    tabIndex={-1}
                    aria-label={t('row.next', { slot: label })}
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
            <kbd>C</kbd> {t('list.copy')}
          </button>
          <button className="gbtn" onClick={share}>
            <kbd>L</kbd> {t('list.link')}
          </button>
        </div>
      </section>

      <footer className="cc-foot" aria-label={t('foot.aria')}>
        <span>
          <kbd>Q</kbd> {t('foot.rotate')} <kbd>E</kbd>
        </span>
        <span>
          <kbd aria-label={t('key.up')}><IconArrow dir="up" /></kbd>
          <kbd aria-label={t('key.down')}><IconArrow dir="down" /></kbd> {t('foot.select')}
        </span>
        <span>
          <kbd aria-label={t('key.left')}><IconArrow dir="left" /></kbd>
          <kbd aria-label={t('key.right')}><IconArrow dir="right" /></kbd> {t('foot.change')}
        </span>
        <span className="foot-g">
          <kbd>G</kbd> {t('foot.grid')}
        </span>
      </footer>

      <div className="toast-host" role="status" aria-live="polite">
        {toast && (
          <div className="toast">
            <span>{toast.text}</span>
            {toast.undo && (
              <button className="toast-undo" onClick={toast.undo}>
                {t('toast.undo')}
              </button>
            )}
          </div>
        )}
      </div>

      <Modal open={dialog === 'pack'} title={t('pack.title')} closeLabel={t('or.close')} onClose={closeDialog}>
        <p className="kp-lead">{t('pack.lead')}</p>
        <PackConnect highlight={packAsk} />
      </Modal>
      <Modal open={dialog === 'key'} title={t('or.title')} closeLabel={t('or.close')} onClose={closeDialog}>
        <KeyPanel />
        <div className="modal-foot">
          <button type="button" className="btn primary" onClick={closeDialog}>
            {t('or.done')}
          </button>
        </div>
      </Modal>
    </div>
  );
}

/** Шапка: живое 3D (набор ассетов), ключ OpenRouter и язык интерфейса. */
function UtilBar({ lang, setLang, onPack, onKey }: { lang: Lang; setLang: (l: Lang) => void; onPack: () => void; onKey: () => void }) {
  const { t } = useI18n();
  const pack = usePackState();
  const or = useOrSettings();
  const packState =
    pack.status === 'ready' && !pack.busy ? t('pack.chipReady') : pack.status === 'connecting' || pack.busy ? t('pack.chipBusy') : pack.status === 'error' ? t('pack.chipError') : t('pack.chipNone');
  const packLabel = t('pack.chipAria', { state: packState });
  const keyLabel = t('or.chipAria', { state: or.key ? t('or.stateSet') : t('or.stateUnset') });
  const keyOk = or.check.s === 'ok';
  const keyBad = or.check.s === 'fail';
  return (
    <nav className="cc-util" aria-label={t('util.aria')}>
      <button type="button" className="util-btn" data-state={pack.status} onClick={onPack} aria-label={packLabel} title={packLabel}>
        <IconCube />
        <span className="util-text">
          {t('pack.chip')} <b>{packState}</b>
        </span>
        <i className="util-dot" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="util-btn"
        data-state={!or.key ? 'none' : keyBad ? 'error' : keyOk ? 'ready' : 'set'}
        onClick={onKey}
        aria-label={keyLabel}
        title={keyLabel}
      >
        <IconKey />
        <span className="util-text">{t('or.chip')}</span>
        <i className="util-dot" aria-hidden="true" />
      </button>
      <div className="util-lang" role="group" aria-label={t('lang.group')}>
        {LANGS.map((l) => (
          <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)} title={t(l === 'ru' ? 'lang.ru' : 'lang.en')}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
    </nav>
  );
}

/** Плитка типа тела: портрет V, отрендеренный 3D-движком приложения (public/portraits). */
function BodyCard({ g, active, onPick }: { g: Gender; active: boolean; onPick: () => void }) {
  const { t } = useI18n();
  const [noImg, setNoImg] = useState(false);
  const name = bodyName(g, t);
  return (
    <button className="body-card" aria-pressed={active} onClick={onPick} aria-label={t('body.aria', { n: BODY_N[g], name: name.toLowerCase() })}>
      <span className="body-pic" aria-hidden="true">
        {noImg ? <IconBust className="body-img body-ph" /> : <img className="body-img" src={portraitUrl(g)} alt="" draggable={false} onError={() => setNoImg(true)} />}
        <i className="body-fx" />
      </span>
      <span className="body-tag" aria-hidden="true">
        <span>{name}</span>
        <b>{BODY_N[g]}</b>
      </span>
    </button>
  );
}

function optionCaption(slotId: string, o: Option | undefined, gender: Gender, lang: Lang): string {
  if (!o) return '';
  if (slotId === 'hairstyle') return hairDescription(gender, o)[lang];
  if (slotId === 'eyebrows') return browDescription(o)?.[lang] ?? '';
  if (isMorph(slotId)) return morphInfo(gender, slotId).options.find((m) => m.i === o.i)?.text[lang] ?? '';
  const l = o.label[lang] || o.label.ru;
  return /^\d+$/.test(l) ? '' : l;
}

function InfoBox({
  vs,
  gender,
  in3d,
  missing3d,
  prov,
  done,
  onDone,
  doneCount,
  total,
}: {
  vs: VisibleSlot;
  gender: Gender;
  /** the live 3D model is on screen (the 2D portrait draws these rows itself) */
  in3d: boolean;
  /** parts of the pack it lacks: their rows are not drawn in 3D */
  missing3d: ReadonlySet<PackPart>;
  prov?: ScanProvenance;
  done: boolean;
  onDone: () => void;
  doneCount: number;
  total: number;
}) {
  const { t, loc, lang } = useI18n();
  const caption = optionCaption(vs.slot.id, vs.option, gender, lang);
  const label = loc(vs.slot.label);
  return (
    <div className="info">
      <div aria-live="polite">
        <div className="info-head">
          <span>{label}</span>
          <b>
            {pad2(displayNumber(vs.variant, vs.value))}
            <small> / {pad2(vs.variant.options.length)}</small>
          </b>
        </div>
        {caption && <p>{caption}</p>}
        {in3d && notIn3d(vs.slot.id, missing3d) && <p className="info-not3d">{t('info.not3d')}</p>}
        {prov && (
          <p className="info-prov">
            {t('info.prov', { n: pad2(displayNumber(vs.variant, prov.value)), src: srcName(prov.src, t), p: Math.round(prov.conf * 100) })}
            {prov.why ? ` — ${loc(prov.why)}` : ''}
          </p>
        )}
      </div>
      {/* Отметка для переноса в игру: какие строки уже выставлены в редакторе игры */}
      <div className="info-done">
        <button className="done-btn" role="checkbox" aria-checked={done} aria-label={t('info.doneAria', { slot: label })} onClick={onDone}>
          <span className="done-mark" aria-hidden="true">
            {done && <IconCheck />}
          </span>
          <span>
            {t('info.doneShort')}
            <span className="done-tail">{t('info.doneTail')}</span>
          </span>
          <kbd aria-hidden="true">X</kbd>
        </button>
        <span className="done-count">{t('info.count', { done: doneCount, total })}</span>
      </div>
    </div>
  );
}

function Picker({
  vs,
  gender,
  prov,
  onChoose,
  onClose,
}: {
  vs: VisibleSlot;
  gender: Gender;
  prov?: ScanProvenance;
  onChoose: (i: number) => void;
  onClose: () => void;
}) {
  const { t, loc } = useI18n();
  const gridRef = useRef<HTMLDivElement>(null);
  const label = loc(vs.slot.label);
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
  // Phone: the grid is a bottom sheet under the viewer. The viewer sticks to the top only once
  // the page is scrolled past the title, so scroll that far: V stays fully visible above the grid
  useEffect(() => {
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    const stage = document.querySelector<HTMLElement>('.cc-stage');
    const top = stage?.getBoundingClientRect().top ?? 0;
    if (top > 0) window.scrollBy({ top, behavior: 'instant' });
  }, []);
  return (
    <div className="picker" role="dialog" aria-label={t('picker.aria', { slot: label })}>
      <div className="picker-head">
        <span>{label}</span>
        <button onClick={onClose} aria-label={t('picker.close')}>
          <IconClose />
        </button>
      </div>
      <div className="picker-grid" role="radiogroup" aria-label={label} ref={gridRef}>
        {vs.variant.options.map((o, k) => {
          const name = loc(o.label);
          return (
            <button
              key={o.i}
              role="radio"
              aria-checked={o.i === vs.value}
              tabIndex={o.i === vs.value ? 0 : -1}
              aria-label={`${pad2(k + 1)}${name && !/^\d+$/.test(name) ? ` — ${name}` : ''}`}
              title={name && !/^\d+$/.test(name) ? name : undefined}
              className="cell"
              onClick={() => onChoose(o.i)}
              onDoubleClick={onClose}
            >
              <Swatch gender={gender} slotId={vs.slot.id} option={o} className="sw" />
              <span className="n">{pad2(k + 1)}</span>
              {prov?.value === o.i && <span className="pick" title={t('picker.scanned')} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
