import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { displayNumber, getIndex, type Gender } from '../model/catalog';
import { slotValue, type CharacterState } from '../model/state';
import { analyzePhoto, type PhotoAnalysis } from './analyze';
import { applySuggestions, localSuggestions, mergeSuggestions, type Source, type Suggestion } from './match';
import { buildPrompt, callOpenRouter, DEFAULT_MODELS, listVisionModels, parseLlm, photoToDataUrl, type ModelInfo } from './llm';
import { IconCopy, IconDownload, IconUpload } from '../ui/Icons';

export interface ScanProvenance {
  src: Source;
  conf: number;
  why?: string;
  value: number;
}

const ls = {
  get: (k: string, d = '') => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* без сохранения */
    }
  },
};

type Tab = 'model' | 'manual';
const CONTOUR = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380, 61, 40, 0, 270, 291, 321, 17, 91, 1, 98, 327, 168, 468, 473, 70, 105, 107, 336, 334, 300];

export default function ScanPanel({
  gender,
  base,
  onApply,
  onGender,
}: {
  gender: Gender;
  base: CharacterState;
  onApply: (s: CharacterState, p: Record<string, ScanProvenance>) => void;
  onGender: (g: Gender) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PhotoAnalysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [llm, setLlm] = useState<{ sugg: Suggestion[]; bodyType?: Gender; notes?: string } | null>(null);
  const [tab, setTab] = useState<Tab>(() => (ls.get('vm.orKey') ? 'model' : 'manual'));
  const [key, setKey] = useState(() => ls.get('vm.orKey'));
  const [model, setModel] = useState(() => ls.get('vm.orModel', DEFAULT_MODELS[0]));
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [manual, setManual] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => ls.set('vm.orKey', key), [key]);
  useEffect(() => ls.set('vm.orModel', model), [model]);
  useEffect(() => {
    listVisionModels().then(setModels).catch(() => setModels([]));
  }, []);

  const local = useMemo(() => (analysis ? localSuggestions(gender, analysis) : []), [analysis, gender]);
  const merged = useMemo(() => mergeSuggestions(local, llm?.sugg ?? []), [local, llm]);
  const preview = useMemo(() => applySuggestions(base, merged), [base, merged]);
  const prompt = useMemo(() => buildPrompt(gender, analysis), [gender, analysis]);

  const load = useCallback((url: string) => {
    setError(null);
    setAnalysis(null);
    setLlm(null);
    setImgUrl(url);
  }, []);

  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setError('Нужен файл изображения: JPG, PNG или WebP.');
      return;
    }
    load(URL.createObjectURL(f));
  };

  // Для автоматической проверки и отладки: загрузить фото по URL
  useEffect(() => {
    (window as unknown as { __vmLoad?: (u: string) => void }).__vmLoad = load;
  }, [load]);

  const runAnalysis = useCallback(async () => {
    const img = imgRef.current;
    if (!img) return;
    setBusy('Ищу лицо и замеряю черты…');
    setError(null);
    try {
      const a = await analyzePhoto(img);
      setAnalysis(a);
    } catch (e) {
      setError(
        (e as Error).message === 'NO_FACE'
          ? 'Лицо не найдено. Нужен снимок анфас, лицо целиком в кадре, без сильного наклона.'
          : `Не удалось проанализировать фото: ${(e as Error).message}`,
      );
    } finally {
      setBusy(null);
    }
  }, []);

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
    setBusy(`Модель ${model} изучает фото…`);
    setError(null);
    try {
      const dataUrl = await photoToDataUrl(img);
      const text = await callOpenRouter({ key: key.trim(), model, imageDataUrl: dataUrl, prompt: prompt.text, signal: ac.signal });
      const res = parseLlm(gender, text);
      setLlm({ sugg: res.suggestions, bodyType: res.bodyType, notes: res.notes });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const parseManual = () => {
    try {
      const res = parseLlm(gender, manual);
      setLlm({ sugg: res.suggestions, bodyType: res.bodyType, notes: res.notes });
      setError(null);
    } catch (e) {
      setError(`Ответ не разобран: ${(e as Error).message}`);
    }
  };

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

  const freeModels = models?.filter((m) => m.free) ?? [];
  const paidModels = models?.filter((m) => !m.free).slice(0, 40) ?? [];

  return (
    <div className="scan">
      <div>
        <h1 style={{ margin: 0, font: '600 34px/1.05 var(--font-sign)' }}>Скан фото → настройки V</h1>
        <p className="muted" style={{ marginTop: 6, maxWidth: '70ch' }}>
          Лицо измеряется прямо в браузере: фото никуда не уходит, пока вы сами не отправите его модели. Лучше всего работает снимок анфас при ровном дневном свете.
        </p>
      </div>
      <div className="scan-grid">
        <div style={{ display: 'grid', gap: 12 }}>
          {imgUrl ? (
            <div className="photo">
              <img ref={imgRef} src={imgUrl} alt="Загруженное фото" crossOrigin="anonymous" onLoad={runAnalysis} onError={() => setError('Не удалось открыть изображение.')} />
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
              <b>Перетащите фото сюда</b>
              <span>или нажмите, чтобы выбрать файл</span>
              <span className="muted">JPG, PNG, WebP · одно лицо, анфас</span>
              <input type="file" accept="image/*" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0])} />
            </label>
          )}
          {imgUrl && (
            <div className="row">
              <label className="btn">
                <IconUpload /> Другое фото
                <input type="file" accept="image/*" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0])} />
              </label>
              <div className="seg" role="group" aria-label="Для какого V подбирать">
                {(['male', 'female'] as Gender[]).map((g) => (
                  <button key={g} aria-pressed={gender === g} onClick={() => onGender(g)}>
                    {g === 'male' ? 'Тип 1' : 'Тип 2'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {analysis && (
            <div className="panel">
              <h3>Замеры</h3>
              <div className="row" style={{ gap: 14 }}>
                {(
                  [
                    ['Кожа', analysis.colors.skin?.hex],
                    ['Радужка', analysis.colors.iris?.hex],
                    ['Волосы', analysis.colors.hair?.hex],
                    ['Брови', analysis.colors.brows?.hex],
                    ['Губы', analysis.colors.lips?.hex],
                  ] as const
                ).map(([n, hex]) =>
                  hex ? (
                    <span key={n} className="row" style={{ gap: 6 }}>
                      <i style={{ width: 16, height: 16, borderRadius: 4, background: hex, display: 'inline-block', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.2)' }} />
                      <span className="muted">{n}</span>
                    </span>
                  ) : null,
                )}
              </div>
              {Math.abs(analysis.yaw) > 12 && <p className="status err" style={{ marginBottom: 0 }}>Голова повёрнута на {Math.abs(analysis.yaw).toFixed(0)}° — форма лица измерена неточно.</p>}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          {busy && (
            <div className="panel" role="status">
              <div className="status">{busy}</div>
              <div className="bar" style={{ marginTop: 10 }}>
                <i />
              </div>
            </div>
          )}
          {error && (
            <div className="panel" role="alert">
              <div className="status err">{error}</div>
            </div>
          )}
          {!imgUrl && !error && (
            <div className="panel">
              <h3>Как это работает</h3>
              <p className="muted" style={{ margin: 0 }}>
                1. Детектор находит 478 точек лица и измеряет пропорции глаз, носа, рта и челюсти — так же, как мы измерили каждый вариант головы V в игре. 2. Цвета кожи, радужки,
                волос и бровей сравниваются с образцами игры. 3. Модель (по вашему ключу OpenRouter) уточняет то, что не измерить линейкой: причёску, бороду, шрамы, веснушки.
              </p>
            </div>
          )}

          {analysis && (
            <div className="panel">
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}>
                  Нейросеть OpenRouter
                </button>
                <button role="tab" aria-selected={tab === 'manual'} onClick={() => setTab('manual')}>
                  Ручной ответ
                </button>
              </div>
              {tab === 'model' ? (
                <div>
                  <div className="field">
                    <label htmlFor="or-key">Ключ OpenRouter (хранится только в этом браузере)</label>
                    <input id="or-key" className="input" type="password" autoComplete="off" placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="or-model">Модель с поддержкой изображений</label>
                    <select id="or-model" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                      {!models?.some((m) => m.id === model) && <option value={model}>{model}</option>}
                      {freeModels.length > 0 && (
                        <optgroup label="Бесплатные">
                          {freeModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {paidModels.length > 0 && (
                        <optgroup label="Платные (по возрастанию цены)">
                          {paidModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} · ${(m.pricePrompt * 1e6).toFixed(2)}/1M
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>
                  <div className="row">
                    <button className="btn primary" disabled={!key.trim() || !!busy} onClick={askModel}>
                      Уточнить нейросетью
                    </button>
                    {!key.trim() && <span className="muted">Без ключа работает только локальный замер.</span>}
                  </div>
                </div>
              ) : (
                <div>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Скопируйте промпт и фото в любую мультимодальную модель (ChatGPT, Claude, Gemini), затем вставьте её JSON-ответ ниже.
                  </p>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <button className="btn" onClick={() => navigator.clipboard.writeText(prompt.text).catch(() => setError('Буфер обмена недоступен'))}>
                      <IconCopy /> Копировать промпт
                    </button>
                    <button className="btn" onClick={downloadPhoto}>
                      <IconDownload /> Скачать фото
                    </button>
                  </div>
                  <div className="field">
                    <label htmlFor="manual">Ответ модели (JSON)</label>
                    <textarea id="manual" className="input textarea" value={manual} onChange={(e) => setManual(e.target.value)} placeholder='{"slots":{"hairstyle":{"n":12,"conf":0.7}}}' />
                  </div>
                  <button className="btn primary" disabled={!manual.trim()} onClick={parseManual}>
                    Разобрать ответ
                  </button>
                </div>
              )}
              {llm?.bodyType && llm.bodyType !== gender && (
                <p className="status" style={{ marginBottom: 0 }}>
                  Модель считает, что ближе тип тела {llm.bodyType === 'male' ? '1' : '2'}.{' '}
                  <button className="btn ghost" onClick={() => onGender(llm.bodyType!)}>
                    Переключить
                  </button>
                </p>
              )}
              {llm?.notes && <p className="muted" style={{ marginBottom: 0 }}>{llm.notes}</p>}
            </div>
          )}

          {analysis && rows.length > 0 && (
            <div className="panel">
              <h3>Подбор</h3>
              <ul className="result-list">
                {rows.map(({ s, slot, v }) => (
                  <li key={s.slotId}>
                    <span className="conf" title={`Уверенность ${Math.round(s.conf * 100)}%`}>
                      <i style={{ width: 6 + s.conf * 16, height: 6 + s.conf * 16, opacity: 0.35 + s.conf * 0.65 }} />
                    </span>
                    <span>
                      {slot!.label.ru} <span className="src">{s.src === 'llm' ? 'модель' : 'замер'}</span>
                      {s.why && <span className="why">{s.why}</span>}
                    </span>
                    <span className="num" style={{ font: '700 22px/1 var(--font-sign)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {(v!.option?.iris ?? v!.option?.hex) && <i style={{ width: 14, height: 14, borderRadius: 3, background: v!.option?.iris ?? v!.option?.hex }} />}
                      {displayNumber(v!.variant, v!.value)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={apply}>
                  Применить к V
                </button>
                <span className="muted">Остальные слоты останутся как есть.</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
