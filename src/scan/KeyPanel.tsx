// OpenRouter key and model: where to get a key, paste / show / remove, check it, pick a
// free vision model. Everything stays in this browser (openrouter.ts).
import { useEffect, useId, useState, type CSSProperties } from 'react';
import { useI18n, type T } from '../i18n';
import { IconExternal } from '../ui/Icons';
import {
  defaultModel,
  KEYS_URL,
  loadModels,
  looksLikeKey,
  OpenRouterError,
  runKeyCheck,
  setOrKey,
  setOrModel,
  setOrRemember,
  SHARED_ORIGIN,
  useOrSettings,
  type KeyCheck,
  type ModelInfo,
} from './openrouter';

/** Whether the browser can mask a text field (-webkit-text-security). */
const MASKED_TEXT = typeof CSS !== 'undefined' && !!CSS.supports?.('-webkit-text-security', 'disc');

/** UI text of an OpenRouter error. */
export function orErrorText(e: unknown, t: T): string {
  if (e instanceof OpenRouterError) {
    switch (e.code) {
      case 'unauthorized':
        return t('llm.unauthorized');
      case 'payment':
        return t('llm.payment');
      case 'forbidden':
        return t('llm.forbidden');
      case 'rate':
        return t('llm.rate');
      case 'model':
        return t('llm.model', { detail: e.detail || String(e.status ?? '') });
      case 'timeout':
        return t('llm.timeout');
      case 'network':
        return t('llm.network');
      case 'badJson':
        return t('llm.badJson');
      case 'empty':
        return t('llm.empty');
      default:
        return t('llm.http', { status: e.status ?? '', detail: e.detail ?? '' });
    }
  }
  return (e as Error)?.message ?? String(e);
}

function checkText(c: KeyCheck, t: T): { cls: string; text: string } | null {
  if (c.s === 'checking') return { cls: '', text: t('or.checking') };
  if (c.s === 'fail') return { cls: 'err', text: orErrorText(c.err, t) };
  if (c.s === 'ok') {
    const i = c.info;
    const head = i.label ? t('or.okLabel', { label: i.label }) : t('or.ok');
    const tier = i.freeTier ? ` ${t('or.okFree')}` : '';
    const lim = i.limitRemaining === null ? ` ${t('or.okUnlimited')}` : ` ${t('or.okCredits', { n: i.limitRemaining.toFixed(2) })}`;
    return { cls: 'ok', text: head + tier + lim };
  }
  return null;
}

/**
 * Shared model list for the picker; null while loading (or not requested), [] when it failed.
 * enabled = false: nothing is fetched — a visitor who never stored a key does not contact
 * openrouter.ai just by opening the scan.
 */
export function useModels(enabled = true): { models: ModelInfo[] | null; failed: boolean; retry: () => void } {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    setFailed(false);
    loadModels()
      .then((m) => !off && setModels(m))
      .catch(() => {
        if (off) return;
        setModels([]);
        setFailed(true);
      });
    return () => {
      off = true;
    };
  }, [n, enabled]);
  return { models, failed, retry: () => setN((x) => x + 1) };
}

export default function KeyPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const or = useOrSettings();
  const { models, failed, retry } = useModels();
  const [draft, setDraft] = useState(or.key);
  const [show, setShow] = useState(false);
  const keyId = useId();
  const modelId = useId();
  const statusId = useId();
  const model = or.model || defaultModel(models);

  // the stored key changed elsewhere (other dialog, cleared): follow it
  useEffect(() => setDraft(or.key), [or.key]);

  const commit = (v: string) => {
    setDraft(v);
    setOrKey(v);
  };
  const paste = async () => {
    try {
      const v = (await navigator.clipboard.readText()).trim();
      if (v) commit(v);
    } catch {
      document.getElementById(keyId)?.focus();
    }
  };

  const status = checkText(or.check, t);
  const formatWarn = !!or.key && !looksLikeKey(or.key);
  const free = models?.filter((m) => m.free) ?? [];
  const paid = models?.filter((m) => !m.free).slice(0, 40) ?? [];

  return (
    <div className="keypanel">
      {!compact && (
        <>
          <p className="kp-lead">{t('or.lead')}</p>
          <div className="kp-how">
            <h3>{t('or.howTitle')}</h3>
            <ol className="steps">
              <li>{t('or.how1')}</li>
              <li>{t('or.how2')}</li>
              <li>{t('or.how3')}</li>
            </ol>
            <a className="btn" href={KEYS_URL} target="_blank" rel="noopener noreferrer">
              {t('or.openKeys')} <IconExternal />
            </a>
          </div>
        </>
      )}
      {compact && !or.key && (
        <p className="muted kp-get">
          {t('or.how3')}{' '}
          <a href={KEYS_URL} target="_blank" rel="noopener noreferrer">
            openrouter.ai/keys
          </a>
        </p>
      )}

      <div className="field">
        <label htmlFor={keyId}>{t('or.keyLabel')}</label>
        <div className="kp-key">
          <input
            id={keyId}
            className="input"
            // An API key is not a site password: a masked text field keeps password
            // managers from offering to save it or fill a login here. Browsers without
            // text masking fall back to a password field.
            type={show || MASKED_TEXT ? 'text' : 'password'}
            style={!show && MASKED_TEXT ? ({ WebkitTextSecurity: 'disc' } as CSSProperties) : undefined}
            name="openrouter-api-key"
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            data-form-type="other"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="sk-or-v1-…"
            value={draft}
            aria-describedby={statusId}
            onChange={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && or.key) void runKeyCheck();
            }}
          />
          <button type="button" className="btn" onClick={() => setShow((s) => !s)} aria-pressed={show}>
            {show ? t('or.hide') : t('or.show')}
          </button>
        </div>
        <div className="row">
          <button type="button" className="btn primary" disabled={!or.key || or.check.s === 'checking'} onClick={() => void runKeyCheck()}>
            {t('or.check')}
          </button>
          {typeof navigator !== 'undefined' && !!navigator.clipboard?.readText && (
            <button type="button" className="btn" onClick={paste}>
              {t('or.paste')}
            </button>
          )}
          {!!or.key && (
            <button type="button" className="btn ghost" onClick={() => commit('')}>
              {t('or.clear')}
            </button>
          )}
        </div>
        <p id={statusId} className={`status ${status?.cls ?? (formatWarn ? 'warn' : '')}`} role="status" aria-live="polite">
          {status?.text ?? (formatWarn ? t('or.format') : or.key ? t('or.unchecked') : t('or.none'))}
        </p>
        <label className="kp-remember">
          <input type="checkbox" checked={or.remember} onChange={(e) => setOrRemember(e.target.checked)} />
          <span>{t('or.remember')}</span>
        </label>
      </div>

      <div className="field">
        <label htmlFor={modelId}>{t('or.modelLabel')}</label>
        <select id={modelId} className="select" value={model} onChange={(e) => setOrModel(e.target.value)} disabled={models === null}>
          {models === null && <option value={model}>{t('or.modelsLoading')}</option>}
          {models !== null && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
          {free.length > 0 && (
            <optgroup label={t('or.free')}>
              {free.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
          {paid.length > 0 && (
            <optgroup label={t('or.paid')}>
              {paid.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {t('or.perM', { price: (m.pricePrompt * 1e6).toFixed(2) })}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {failed ? (
          <p className="status warn">
            {t('or.modelsFailed', { model })}{' '}
            <button type="button" className="btn ghost" onClick={retry}>
              {t('or.modelsRetry')}
            </button>
          </p>
        ) : (
          <p className="muted">{t('or.freeHint')}</p>
        )}
      </div>

      <p className="kp-privacy">
        {t('or.privacy')}
        {SHARED_ORIGIN && <> {t('or.sharedOrigin')}</>}
      </p>
      {!compact && <p className="muted">{t('or.noKeyPath')}</p>}
    </div>
  );
}
