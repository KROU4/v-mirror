// Asset pack UX: the hero shown instead of the 3D scene while no pack is connected, and the
// connect panel (also in the header dialog). The site never ships game files; the user builds
// a pack from their own install (npm run pack) and opens its folder here.
import { useState } from 'react';
import { connectPackDirectory, disconnectPack, restorePack, type PackState } from '../assets/pack';
import { PACK_GUIDE_URL, publicUrl } from '../config';
import { useI18n, type T } from '../i18n';
import type { Gender } from '../model/catalog';
import type { CharacterState } from '../model/state';
import { IconExternal, IconFolder } from './Icons';
import Portrait from './Portrait';
import { usePackState } from './SwatchChip';

/** pack.ts reports errors in English: show the known ones in the UI language. */
export function packErrorText(msg: string | undefined, t: T): string {
  const m = msg ?? '';
  if (/pack\.json is missing/.test(m)) return t('pack.err.missing');
  if (/pack\.json is not valid/.test(m)) return t('pack.err.json');
  if (/Unsupported asset pack format/.test(m)) return t('pack.err.format');
  if (/incomplete/.test(m)) return t('pack.err.incomplete');
  if (/not granted|NotAllowed|SecurityError/i.test(m)) return t('pack.err.permission');
  if (/cannot open folders/.test(m)) return t('pack.err.browser');
  // the folder was moved, rebuilt or unplugged after it was connected
  if (/NotReadable|NotFound|InvalidState|not in the asset pack|could not be found|cannot be read|could not be read/i.test(m)) return t('pack.err.read');
  return t('pack.err.generic', { msg: m });
}

export function canPickFolders(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function') return true;
  return 'webkitdirectory' in document.createElement('input');
}

export const portraitUrl = (g: Gender) => publicUrl(`portraits/${g === 'male' ? 'v_pma' : 'v_pwa'}.webp`);

/** Status line, buttons and how-to of the asset pack. */
export function PackConnect({ steps = true }: { steps?: boolean }) {
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

  return (
    <div className="packconnect">
      {line && (
        <p className={`status ${line.cls}`} role="status" aria-live="polite">
          {busy && <i className="spin" aria-hidden="true" />}
          {line.text}
        </p>
      )}
      {pack.status !== 'ready' && steps && (
        <ol className="steps">
          <li>{t('pack.step1')}</li>
          <li>
            <PackCommand text={t('pack.step2')} />
          </li>
          <li>{t('pack.step3')}</li>
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
            <button type="button" className={`btn ${pack.remembered ? '' : 'primary'}`} onClick={connect} disabled={busy || !supported}>
              <IconFolder /> {pack.remembered ? t('pack.another') : t('pack.connect')}
            </button>
          </>
        ) : null}
        <a className="btn ghost" href={PACK_GUIDE_URL} target="_blank" rel="noopener noreferrer">
          {t('pack.guide')} <IconExternal />
        </a>
      </div>
    </div>
  );
}

/** «npm run pack …» inside a step: the command is set as code so it can be copied as is. */
function PackCommand({ text }: { text: string }) {
  const m = /(npm run pack[^:：]*)/.exec(text);
  if (!m) return <>{text}</>;
  const [before, after] = [text.slice(0, m.index), text.slice(m.index + m[1].length)];
  return (
    <>
      {before}
      <code>{m[1].trim()}</code>
      {after}
    </>
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
}: {
  gender: Gender;
  state: CharacterState;
  webglError: boolean;
  onMore: () => void;
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
          <PackConnect />
        </div>
        <button type="button" className="btn hero-more" onClick={onMore}>
          {t('pack.more')}
        </button>
      </section>
    </div>
  );
}

export type { PackState };
