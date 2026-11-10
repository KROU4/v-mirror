import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { displayNumber, getIndex, type Gender, type Loc } from '../model/catalog';
import { slotValue, type CharacterState } from '../model/state';
import { analyzePhoto, type PhotoAnalysis } from './analyze';
import { getLandmarker } from './landmarker';
import { applySuggestions, localSuggestions, mergeSuggestions, type Source, type Suggestion } from './match';
import { buildPrompt, callOpenRouter, LlmError, parseLlm, photoToDataUrl } from './llm';
import { defaultModel, useOrSettings } from './openrouter';
import KeyPanel, { orErrorText, useModels } from './KeyPanel';
import { IconCopy, IconDownload, IconKey, IconUpload } from '../ui/Icons';
import { pad2 } from '../ui/format';
import { Swatch } from '../ui/SwatchChip';
import { NOT_IN_3D } from '../ui/avatar/look';
import { useI18n, type T } from '../i18n';

export interface ScanProvenance {
  src: Source;
  conf: number;
  why?: string | Loc;
  value: number;
}

const parseErrorText = (e: unknown, t: T) =>
  e instanceof LlmError
    ? t(e.code === 'noJson' ? 'llm.noJson' : 'llm.brokenJson')
    : t('scan.err.generic', { msg: (e as Error)?.message ?? String(e) });

type Tab = 'model' | 'manual';
const CONTOUR = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380, 61, 40, 0, 270, 291, 321, 17, 91, 1, 98, 327, 168, 468, 473, 70, 105, 107, 336, 334, 300];

/** Длинная сторона снимка для детектора лица и замера цветов, px. */
export const ANALYSIS_MAX_PX = 2048;

export default function ScanPanel({
  gender,
  base,
  in3d,
  onApply,
  onGender,
  onKeySettings,
}: {
  gender: Gender;
  base: CharacterState;
  /** на сцене 3D-модель (как у InfoBox): только тогда строки без 3D помечаются */
  in3d: boolean;
  onApply: (s: CharacterState, p: Record<string, ScanProvenance>) => void;
  onGender: (g: Gender) => void;
  onKeySettings: () => void;
}) {
  const { t, loc, lang } = useI18n();
  const or = useOrSettings();
  // Список моделей — только когда ключ сохранён: без ключа скан к openrouter.ai не обращается
  const { models } = useModels(!!or.key);
  const key = or.key;
  const model = or.model || defaultModel(models);
  const modelName = models?.find((m) => m.id === model)?.name ?? model;
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PhotoAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // Ответ модели привязан к полу, для которого строился промпт: номера вариантов у типов тела разные
  const [llmRaw, setLlm] = useState<{ gender: Gender; sugg: Suggestion[]; bodyType?: Gender; notes?: string; hints?: Loc[] } | null>(null);
  const llm = llmRaw && llmRaw.gender === gender ? llmRaw : null;
  const llmStale = !!llmRaw && llmRaw.gender !== gender;
  const [tab, setTab] = useState<Tab>(() => (or.key ? 'model' : 'manual'));
  // Ключ вводят прямо во вкладке: поле не пропадает после первого символа
  const [inlineKey] = useState(() => !or.key);
  const [manual, setManual] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const objUrlRef = useRef<string | null>(null);
  // Номер текущего фото: ответы анализа и модели по прежнему фото отбрасываются
  const photoSeq = useRef(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const busy = asking ?? (analyzing ? t('scan.busyFace') : null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    },
    [],
  );

  // Смена типа тела отменяет запрос к модели: его номера относились бы к другому каталогу
  useEffect(() => {
    abortRef.current?.abort();
    setAsking(null);
  }, [gender]);

  // Короткая отметка «промпт скопирован» гаснет сама
  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), 2200);
    return () => window.clearTimeout(id);
  }, [note]);

  const local = useMemo(() => (analysis ? localSuggestions(gender, analysis) : []), [analysis, gender]);
  const merged = useMemo(() => mergeSuggestions(local, llm?.sugg ?? []), [local, llm]);
  const preview = useMemo(() => applySuggestions(base, merged), [base, merged]);
  const prompt = useMemo(() => buildPrompt(gender, analysis, lang), [gender, analysis, lang]);

  const load = useCallback((url: string) => {
    photoSeq.current++;
    abortRef.current?.abort();
    if (objUrlRef.current && objUrlRef.current !== url) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
    setError(null);
    setAnalysis(null);
    setLlm(null);
    setAsking(null);
    setAnalyzing(false);
    setImgUrl(url);
  }, []);

  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setError(t('scan.notImage'));
      return;
    }
    const url = URL.createObjectURL(f);
    load(url);
    objUrlRef.current = url;
  };

  // Только в разработке: загрузить фото по URL для автоматической проверки
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __vmLoad?: (u: string) => void }).__vmLoad = load;
  }, [load]);

  // Детектор лица (wasm и модель) загружаем сразу при открытии скана, в простое, пока
  // пользователь выбирает фото: это сеть и асинхронная компиляция wasm. Сборка графа на
  // видеокарте (первый detect, ≈ 2 с главного потока) идёт уже по выбранному фото, под
  // индикатором «Ищу лицо», а не неожиданно, пока человек тянется к кнопке «Закрыть»
  useEffect(() => {
    const warm = () => void getLandmarker().catch(() => {});
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 300);
    return () => window.clearTimeout(id);
  }, []);

  const runAnalysis = useCallback(async () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const seq = photoSeq.current;
    // Снимок пикселей сразу: если фото сменят во время анализа, размеры и пиксели не перемешаются.
    // Не больше ANALYSIS_MAX_PX по длинной стороне: фото телефона на 48–200 Мп дали бы холст
    // в сотни мегабайт (iOS Safari рисует пустой холст больше 16,7 Мп — «лицо не найдено»),
    // а точки лица нормализованы, и замер всё равно идёт по уменьшенной копии
    const scale = Math.min(1, ANALYSIS_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const snap = document.createElement('canvas');
    snap.width = Math.max(1, Math.round(img.naturalWidth * scale));
    snap.height = Math.max(1, Math.round(img.naturalHeight * scale));
    snap.getContext('2d')!.drawImage(img, 0, 0, snap.width, snap.height);
    setAnalyzing(true);
    setError(null);
    try {
      // дать браузеру нарисовать индикатор до тяжёлой работы детектора
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const a = await analyzePhoto(snap);
      if (seq === photoSeq.current) setAnalysis(a);
    } catch (e) {
      if (seq !== photoSeq.current) return;
      setError((e as Error).message === 'NO_FACE' ? t('scan.noFace') : t('scan.analyzeFailed', { msg: (e as Error).message }));
    } finally {
      if (seq === photoSeq.current) setAnalyzing(false);
    }
  }, [t]);

  // Точки лица поверх фото
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !analysis) return;
    c.width = analysis.width;
    c.height = analysis.height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    const r = Math.max(1.5, analysis.width / 260);
    ctx.fillStyle = '#2fe0d0';
    for (const i of CONTOUR) {
      const p = analysis.landmarks[i];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x * c.width, p.y * c.height, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [analysis]);

  const askModel = async () => {
    const img = imgRef.current;
    if (!img || !key.trim()) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const seq = photoSeq.current;
    const g = gender;
    const pack = prompt;
    setAsking(t('scan.busyModel', { model: modelName }));
    setError(null);
    try {
      const dataUrl = await photoToDataUrl(img);
      const text = await callOpenRouter({ key: key.trim(), model, imageDataUrl: dataUrl, prompt: pack.text, signal: ac.signal });
      if (ac.signal.aborted || seq !== photoSeq.current) return;
      const res = parseLlm(g, text, pack.slots);
      setLlm({ gender: g, sugg: res.suggestions, bodyType: res.bodyType, notes: res.notes, hints: res.hints });
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && !ac.signal.aborted) setError(e instanceof LlmError ? parseErrorText(e, t) : orErrorText(e, t));
    } finally {
      if (abortRef.current === ac) {
        setAsking(null);
        abortRef.current = null;
      }
    }
  };

  const cancelAsk = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAsking(null);
  };

  const parseManual = () => {
    try {
      const res = parseLlm(gender, manual, prompt.slots);
      setLlm({ gender, sugg: res.suggestions, bodyType: res.bodyType, notes: res.notes, hints: res.hints });
      setError(null);
    } catch (e) {
      setError(t('scan.parseFailed', { msg: parseErrorText(e, t) }));
    }
  };

  const copyPrompt = () =>
    navigator.clipboard
      .writeText(prompt.text)
      .then(() => setNote(t('scan.promptCopied')))
      .catch(() => setError(t('scan.noClipboard')));

  const downloadPhoto = async () => {
    if (!imgRef.current) return;
    const a = document.createElement('a');
    a.href = await photoToDataUrl(imgRef.current, 1024);
    a.download = 'v-mirror-photo.jpg';
    a.click();
  };

  const apply = () => {
    const prov: Record<string, ScanProvenance> = {};
    for (const s of merged) {
      const v = slotValue(preview, s.slotId);
      if (v) prov[s.slotId] = { src: s.src, conf: s.conf, why: s.why, value: v.value };
    }
    onApply(preview, prov);
  };

  const { slotById } = getIndex(gender);
  const rows = merged
    .map((s) => ({ s, slot: slotById.get(s.slotId), v: slotValue(preview, s.slotId) }))
    .filter((r) => r.slot && r.v)
    .sort((a, b) => a.slot!.order - b.slot!.order);

  const measures: [string, string | undefined][] = analysis
    ? [
        [t('scan.c.skin'), analysis.colors.skin?.hex],
        [t('scan.c.iris'), analysis.colors.iris?.hex],
        [t('scan.c.hair'), analysis.colors.hair?.hex],
        [t('scan.c.brows'), analysis.colors.brows?.hex],
        [t('scan.c.lips'), analysis.colors.lips?.hex],
      ]
    : [];

  return (
    <div className="scan">
      <div>
        <h1 className="scan-title">{t('scan.title')}</h1>
        <p className="muted scan-lead">{t('scan.lead')}</p>
      </div>
      <div className="scan-grid">
        <div className="scan-col">
          {imgUrl ? (
            <div className="photo">
              <img ref={imgRef} src={imgUrl} alt={t('scan.photoAlt')} crossOrigin="anonymous" onLoad={runAnalysis} onError={() => setError(t('scan.badImage'))} />
              <canvas ref={canvasRef} aria-hidden="true" />
            </div>
          ) : (
            <label
              className={`drop ${over ? 'over' : ''}`}
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setOver(false);
                onFile(e.dataTransfer.files[0]);
              }}
            >
              <IconUpload />
              <b>
                <span className="fine-only">{t('scan.dropDrag')}</span>
                <span className="touch-only">{t('scan.dropPick')}</span>
              </b>
              <span className="fine-only">{t('scan.dropOr')}</span>
              <span className="muted">{t('scan.dropHint')}</span>
              <input className="vh" type="file" accept="image/*" onChange={(e: ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0])} />
            </label>
          )}
          {imgUrl && (
            <div className="row">
              <label className="btn">
                <IconUpload /> {t('scan.other')}
                <input className="vh" type="file" accept="image/*" onChange={(e: ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0])} />
              </label>
              <div className="seg" role="group" aria-label={t('scan.forWhom')}>
                {(['male', 'female'] as Gender[]).map((g) => (
                  <button key={g} aria-pressed={gender === g} onClick={() => onGender(g)}>
                    {g === 'male' ? t('body.male') : t('body.female')}
                  </button>
                ))}
              </div>
            </div>
          )}
          {analysis && (
            <div className="panel">
              <h3>{t('scan.measures')}</h3>
              <div className="row measures">
                {measures.map(([n, hex]) =>
                  hex ? (
                    <span key={n} className="measure">
                      <i style={{ background: hex }} />
                      <span className="muted">{n}</span>
                    </span>
                  ) : null,
                )}
              </div>
              {analysis.monochrome && <p className="status warn">{t('scan.mono')}</p>}
              {Math.abs(analysis.yaw) > 12 && <p className="status warn">{t('scan.yaw', { deg: Math.abs(analysis.yaw).toFixed(0) })}</p>}
            </div>
          )}
        </div>

        <div className="scan-col">
          {busy && (
            <div className="panel" role="status">
              <div className="status">{busy}</div>
              <div className="bar">
                <i />
              </div>
              {asking && (
                <button type="button" className="btn ghost scan-cancel" onClick={cancelAsk}>
                  {t('scan.cancel')}
                </button>
              )}
            </div>
          )}
          {error && (
            <div className="panel" role="alert">
              <div className="status err">{error}</div>
            </div>
          )}
          {!imgUrl && !error && (
            <div className="panel">
              <h3>{t('scan.how')}</h3>
              <ol className="steps">
                <li>{t('scan.how1')}</li>
                <li>{t('scan.how2')}</li>
                <li>{t('scan.how3')}</li>
              </ol>
            </div>
          )}

          {analysis && (
            <div className="panel">
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}>
                  {t('scan.tabModel')}
                </button>
                <button role="tab" aria-selected={tab === 'manual'} onClick={() => setTab('manual')}>
                  {t('scan.tabManual')}
                </button>
              </div>
              {tab === 'model' ? (
                <div role="tabpanel">
                  {key && !inlineKey ? (
                    <div className="row scan-model">
                      <span className="muted">{t('scan.usingModel', { model: modelName })}</span>
                      <button type="button" className="btn ghost" onClick={onKeySettings}>
                        <IconKey /> {t('scan.keyEdit')}
                      </button>
                    </div>
                  ) : (
                    <KeyPanel compact />
                  )}
                  <div className="row">
                    <button className="btn primary" disabled={!key.trim() || !!busy} onClick={askModel}>
                      {t('scan.ask')}
                    </button>
                    {!key.trim() && <span className="muted">{t('scan.noKey')}</span>}
                  </div>
                </div>
              ) : (
                <div role="tabpanel">
                  <p className="muted">{t('scan.manualLead')}</p>
                  <div className="row">
                    <button className="btn" onClick={copyPrompt}>
                      <IconCopy /> {t('scan.copyPrompt')}
                    </button>
                    <button className="btn" onClick={downloadPhoto}>
                      <IconDownload /> {t('scan.downloadPhoto')}
                    </button>
                    <span className="status ok" role="status">
                      {note}
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="manual">{t('scan.answerLabel')}</label>
                    <textarea
                      id="manual"
                      className="input textarea"
                      value={manual}
                      onChange={(e) => setManual(e.target.value)}
                      placeholder={t('scan.answerPlaceholder')}
                      spellCheck={false}
                    />
                  </div>
                  <button className="btn primary" disabled={!manual.trim()} onClick={parseManual}>
                    {t('scan.parse')}
                  </button>
                </div>
              )}
              {llm?.bodyType && llm.bodyType !== gender && (
                <p className="status">
                  {t('scan.bodyHint', { type: llm.bodyType === 'male' ? t('scan.bodyMale') : t('scan.bodyFemale') })}{' '}
                  <button className="btn ghost" onClick={() => onGender(llm.bodyType!)}>
                    {t('scan.switch')}
                  </button>
                </p>
              )}
              {llmStale && <p className="status">{t('scan.stale')}</p>}
              {llm?.notes && <p className="muted">{llm.notes}</p>}
              {llm?.hints && (
                <ul className="scan-hints">
                  {llm.hints.map((h) => (
                    <li key={h.en}>{loc(h)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {analysis && rows.length > 0 && (
            <div className="panel">
              <h3>{t('scan.results')}</h3>
              <ul className="result-list">
                {rows.map(({ s, slot, v }) => (
                  <li key={s.slotId}>
                    <span className="conf" title={t('scan.conf', { p: Math.round(s.conf * 100) })}>
                      <i style={{ width: 6 + s.conf * 16, height: 6 + s.conf * 16, opacity: 0.35 + s.conf * 0.65 }} />
                      <span className="vh">{t('scan.conf', { p: Math.round(s.conf * 100) })}</span>
                    </span>
                    <span>
                      {loc(slot!.label)} <span className="src">{s.src === 'llm' ? t('src.llm') : t('src.local')}</span>
                      {in3d && NOT_IN_3D.has(s.slotId) && <span className="not3d">{t('scan.not3d')}</span>}
                      {s.why && <span className="why">{loc(s.why)}</span>}
                    </span>
                    <span className="num">
                      {(v!.option?.iris || v!.option?.hex || v!.option?.icon) && (
                        <Swatch gender={gender} slotId={s.slotId} option={v!.option} className="num-sw" />
                      )}
                      {pad2(displayNumber(v!.variant, v!.value))}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="row">
                <button className="btn primary" onClick={apply}>
                  {t('scan.apply')}
                </button>
                <span className="muted">{t('scan.applyNote')}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
