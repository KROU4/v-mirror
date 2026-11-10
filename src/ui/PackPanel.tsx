// Asset pack UX: the hero shown instead of the 3D scene while no pack is connected, and the
// connect panel (also in the header dialog). The site never ships game files; the user builds
// a pack from their own install with the PowerShell one-liner (public/pack.ps1) and opens its
// folder here.
import { useEffect, useRef, useState } from 'react';
import { connectPackDirectory, disconnectPack, restorePack, type PackState } from '../assets/pack';
import { PACK_ALT_DIR, PACK_GUIDE_URL, PACK_ONE_LINER, publicUrl } from '../config';
import { useI18n, type T } from '../i18n';
import type { Gender } from '../model/catalog';
import type { CharacterState } from '../model/state';
import { IconCheck, IconCopy, IconExternal, IconFolder } from './Icons';
import Portrait from './Portrait';
import { usePackState } from './SwatchChip';

/** pack.ts reports errors in English: show the known ones in the UI language. */
export function packErrorText(msg: string | undefined, t: T): string {
  const m = msg ?? '';
  if (/pack\.json is missing/.test(m)) return t('pack.err.missing', packDirs(t));
  if (/pack\.json is not valid/.test(m)) return t('pack.err.json');
  if (/Unsupported asset pack format/.test(m)) return t('pack.err.format');
  if (/incomplete/.test(m)) return t('pack.err.incomplete');
  if (/not granted|NotAllowed|SecurityError/i.test(m)) return t('pack.err.permission');
  if (/cannot open folders/.test(m)) return t('pack.err.browser');
  // the folder was moved, rebuilt or unplugged after it was connected
  if (/NotReadable|NotFound|InvalidState|not in the asset pack|could not be found|cannot be read|could not be read/i.test(m)) return t('pack.err.read');
  return t('pack.err.generic', { msg: m });
}

/** The two default pack folders (pack.mjs defaultOutDir), for the {dir} and {alt} placeholders. */
function packDirs(t: T) {
  return { dir: t('pack.defaultDir'), alt: PACK_ALT_DIR };
}

/** The default pack folders inside a sentence stay on one line ("Documents\V-" | "Mirror pack" reads badly). */
function withPath(text: string, t: T) {
  const paths = Object.values(packDirs(t));
  const rx = new RegExp(`(${paths.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  const parts = text.split(rx);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 ? <span key={i} className="pack-path">{p}</span> : p));
}

export function canPickFolders(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function') return true;
  return 'webkitdirectory' in document.createElement('input');
}

export const portraitUrl = (g: Gender) => publicUrl(`portraits/${g === 'male' ? 'v_pma' : 'v_pwa'}.webp`);

/**
 * Status line, buttons and how-to of the asset pack. `highlight` (the page was opened by the
 * one-liner with ?pack=1): the pack was just built, so the folder button is marked and the
 * default folder is named.
 */
export function PackConnect({ steps = true, highlight = false }: { steps?: boolean; highlight?: boolean }) {
  const { t } = useI18n();
  const pack = usePackState();
  const supported = canPickFolders();
  const busy = pack.status === 'connecting' || !!pack.busy;
  const connect = () => void connectPackDirectory();

  let line: { cls: string; text: string } | null = null;
  if (busy) line = { cls: '', text: t('pack.connecting') };
  else if (pack.status === 'ready' && pack.lastError) line = { cls: 'warn', text: t('pack.keepOld', { msg: packErrorText(pack.lastError, t) }) };
  else if (pack.status === 'error') line = { cls: 'err', text: t('pack.error', { msg: packErrorText(pack.error, t) }) };
  else if (pack.status === 'ready')
    line = {
      cls: 'ok',
      text:
        (pack.source?.kind === 'dir' ? t('pack.readyDir', { name: pack.source.name }) : t('pack.readyDev')) +
        (pack.manifest?.gameVersion ? ` ${t('pack.version', { v: pack.manifest.gameVersion, files: pack.manifest.files ?? '—' })}` : ''),
    };
  else if (!supported) line = { cls: 'warn', text: t('pack.unsupported') };
  // a hint, not a success: nothing is connected yet
  else if (highlight) line = { cls: 'hint', text: t('pack.built', packDirs(t)) };
  const mark = highlight && pack.status !== 'ready' ? ' attn' : '';

  return (
    <div className="packconnect">
      {line && (
        <p className={`status ${line.cls}`} role="status" aria-live="polite">
          {busy && <i className="spin" aria-hidden="true" />}
          <span>{withPath(line.text, t)}</span>
        </p>
      )}
      {pack.status !== 'ready' && steps && (
        <ol className="steps pack-steps">
          <li>
            {t('pack.step1')}
            <PackCommand />
            <span className="pack-note">{t('pack.step1note')}</span>
          </li>
          <li>{withPath(t('pack.step2', packDirs(t)), t)}</li>
        </ol>
      )}
      <div className="row">
        {pack.status === 'ready' && pack.source?.kind === 'dir' ? (
          <>
            <button type="button" className="btn" onClick={connect} disabled={busy}>
              <IconFolder /> {t('pack.another')}
            </button>
            <button type="button" className="btn ghost" onClick={disconnectPack}>
              {t('pack.disconnect')}
            </button>
          </>
        ) : pack.status !== 'ready' ? (
          <>
            {pack.remembered && (
              <button type="button" className="btn primary" onClick={() => void restorePack()} disabled={busy}>
                <IconFolder /> {t('pack.reconnect', { name: pack.remembered })}
              </button>
            )}
            <button
              type="button"
              className={`btn ${pack.remembered && !highlight ? '' : 'primary'}${mark}`}
              onClick={connect}
              disabled={busy || !supported}
              data-attn={mark ? 'true' : undefined}
            >
              <IconFolder /> {pack.remembered && !highlight ? t('pack.another') : t('pack.connect')}
            </button>
          </>
        ) : null}
        <a className="btn ghost pack-guide" href={PACK_GUIDE_URL} target="_blank" rel="noopener noreferrer">
          {t('pack.guide')} <IconExternal />
        </a>
      </div>
    </div>
  );
}

/** The one-liner as code with a Copy button (the command must be pasted exactly as is). */
function PackCommand() {
  const { t } = useI18n();
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const code = useRef<HTMLElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(PACK_ONE_LINER);
      ok = true;
    } catch {
      // no clipboard access (insecure context, permission): select the text for Ctrl+C
      const el = code.current;
      const sel = window.getSelection();
      if (el && sel) {
        const r = document.createRange();
        r.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setCopied(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied('idle'), ok ? 2000 : 6000);
  };
  return (
    <span className="pack-cmd" role="group" aria-label={t('pack.cmdAria')}>
      <code ref={code} className="pack-cmd-text" translate="no">
        {PACK_ONE_LINER}
      </code>
      <button type="button" className={`btn pack-copy${copied === 'ok' ? ' done' : ''}`} onClick={() => void copy()}>
        {copied === 'ok' ? <IconCheck /> : <IconCopy />}
        <span aria-live="polite">{copied === 'ok' ? t('pack.copied') : t('pack.copy')}</span>
      </button>
      {copied === 'fail' && (
        <span className="pack-copyfail" role="status">
          {t('pack.copyFail')}
        </span>
      )}
    </span>
  );
}

/**
 * Stand-in for the 3D scene: the V portrait illustration and an invitation to connect the
 * asset pack (or why 3D failed). The editor and the scan work fully without the pack.
 */
export function PackHero({
  gender,
  state,
  webglError,
  onMore,
  highlight = false,
}: {
  gender: Gender;
  state: CharacterState;
  webglError: boolean;
  onMore: () => void;
  highlight?: boolean;
}) {
  const { t } = useI18n();
  const pack = usePackState();
  const [noImg, setNoImg] = useState<Record<string, boolean>>({});
  const n = gender === 'male' ? '01' : '02';
  const failed = webglError;
  return (
    <div className="hero" data-pack={pack.status}>
      <figure className="hero-fig">
        {noImg[gender] ? (
          <Portrait state={state} className="hero-svg" label={t('avatar.portraitAria')} />
        ) : (
          <img
            className="hero-img"
            src={portraitUrl(gender)}
            alt={t('pack.portraitAlt', { n })}
            draggable={false}
            onError={() => setNoImg((s) => ({ ...s, [gender]: true }))}
          />
        )}
        <i className="hero-fx" aria-hidden="true" />
      </figure>
      <section className="hero-card" aria-labelledby="hero-title">
        <h2 id="hero-title">{failed ? t('pack.title') : t('pack.cta')}</h2>
        {failed ? (
          <p className="status err" role="alert">
            {t('pack.webgl')}
          </p>
        ) : (
          <>
            <p className="hero-lead">{t('pack.lead')}</p>
            <p className="hero-mobile">{t('pack.desktop')}</p>
          </>
        )}
        <div className="hero-full">
          <PackConnect highlight={highlight} />
        </div>
        <button type="button" className="btn hero-more" onClick={onMore}>
          {t('pack.more')}
        </button>
      </section>
    </div>
  );
}

export type { PackState };
