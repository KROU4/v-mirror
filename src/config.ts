// Public links of the project. VITE_REPO_URL overrides the repository at build time.
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const REPO_URL = (env.VITE_REPO_URL || 'https://github.com/KROU4/v-mirror').replace(/\/+$/, '');
export const PACK_GUIDE_URL = `${REPO_URL}/blob/main/docs/ASSET_PACK.md`;

/** URL of a file in public/ that respects the deploy base path (GitHub Pages project sites). */
export function publicUrl(path: string): string {
  const base = env.BASE_URL || '/';
  return base.replace(/\/?$/, '/') + path.replace(/^\/+/, '');
}
