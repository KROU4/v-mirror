// Public links of the project. VITE_REPO_URL overrides the repository at build time.
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const REPO_URL = (env.VITE_REPO_URL || 'https://github.com/KROU4/v-mirror').replace(/\/+$/, '');
export const PACK_GUIDE_URL = `${REPO_URL}/blob/main/docs/ASSET_PACK.md`;

/** Public address of the site (VITE_SITE_URL at build time), with a trailing slash. */
export const SITE_URL = normalizeSite(env.VITE_SITE_URL || 'https://krou4.github.io/v-mirror/');

/** Lower-cased host (CI passes the GitHub owner with its own casing) and a trailing slash. */
export function normalizeSite(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname.replace(/\/*$/, '/');
  } catch {
    return raw.replace(/\/*$/, '/');
  }
}
/** The PowerShell one-liner that builds the asset pack (public/pack.ps1, stamped by the build). */
export const PACK_ONE_LINER = `irm ${SITE_URL}pack.ps1 | iex`;
/**
 * Where the one-liner puts the pack when %USERPROFILE%\Documents does not exist (for example
 * OneDrive moved it) — tools/extract/pack.mjs defaultOutDir. The usual place, Documents\V-Mirror
 * pack, is the i18n key pack.defaultDir: Explorer names the folder in the UI language.
 */
export const PACK_ALT_DIR = '%LOCALAPPDATA%\\v-mirror\\pack';

/** URL of a file in public/ that respects the deploy base path (GitHub Pages project sites). */
export function publicUrl(path: string): string {
  const base = env.BASE_URL || '/';
  return base.replace(/\/?$/, '/') + path.replace(/^\/+/, '');
}
