#!/usr/bin/env node
// Fails when the production build (dist/) contains anything from the game: meshes,
// game texture formats, asset-pack folders, or a byte copy of a file of the local pack.
// The public site ships only the app, MediaPipe, fonts and the V portrait illustrations.
//
// pack.ps1 (the bootstrap of the one-liner `irm <site>/pack.ps1 | iex`) is allowed: it holds no
// game data, only the commit it downloads; the audit checks that the build stamped it.
//
// It also checks index.html: every local src/href starts with the expected base path
// (VITE_BASE, default '/'), and the Content-Security-Policy meta tag is there. In CI the base
// must be given explicitly (VITE_BASE or --base): with the default '/' every URL passes.
//
// And the repository: files git would commit (tracked and not ignored) must not carry game
// renders or texture dumps: images only in public/ (favicon, og, portraits) plus the README
// screenshot docs/screenshot.webp, nothing over
// 1 MB except the generated catalogs.
//
//   node tools/audit-dist.mjs [distDir] [--pack tools/local] [--base /v-mirror/]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** extensions that only game assets use here */
export const BANNED_EXT = ['.glb', '.gltf', '.ktx2', '.basis', '.dds', '.tga', '.xbm', '.mesh', '.morphtarget', '.anims', '.rig', '.mlmask', '.mlsetup', '.archive', '.bk2', '.wem'];
/** asset-pack sections: never part of a build */
export const PACK_DIRS = ['game', 'glb', 'hair', 'tex', 'body', 'head', 'renders', 'swatches', 'local'];
/** where images may live in dist (everything else is reported) */
export const IMAGE_OK = [/^assets\/[^/]+$/, /^portraits\/v_p[mw]a\.webp$/, /^mediapipe\//, /^(favicon|icon|apple-touch-icon|og)[^/]*\.(png|svg|ico|webp)$/];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp', '.exr', '.hdr'];
const MAX_IMAGE = 1.5 * 1024 * 1024;

/**
 * Base path of the build, normalised by the same rule as basePath() in vite.config.ts. Git
 * Bash/MSYS rewrites --base /v-mirror/ into "C:/Program Files/Git/v-mirror/": a drive letter,
 * a colon or a space can only come from such a rewrite, so it is an error with a hint instead
 * of false "outside the base path" failures.
 */
export function normalizeBase(raw) {
  const b = (raw ?? '').trim();
  if (!b || b === '/' || b === './') return b === './' ? './' : '/';
  if (/^https?:\/\//.test(b)) return b.endsWith('/') ? b : b + '/';
  if (/^[A-Za-z]:|:|\s/.test(b))
    throw new Error(`base looks like a file path (${b}). In Git Bash run MSYS_NO_PATHCONV=1 node tools/audit-dist.mjs --base /v-mirror/, or use PowerShell.`);
  return '/' + b.replace(/^\/+|\/+$/g, '') + '/';
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const hashes = new Map();
const sha1 = (f) => {
  let h = hashes.get(f);
  if (!h) hashes.set(f, (h = crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')));
  return h;
};

/** Images the repository may hold (repo-relative paths). */
export const REPO_IMAGE_OK = [
  /^public\/(favicon|icon|apple-touch-icon|og)[^/]*\.(png|svg|ico|webp)$/,
  /^public\/portraits\/v_p[mw]a\.webp$/,
  /^docs\/screenshot\.webp$/, // the README screenshot of the app
];
/** Files allowed above REPO_MAX_FILE. */
export const REPO_BIG_OK = [/^src\/data\/catalog\.(male|female)\.json$/];
export const REPO_MAX_FILE = 1024 * 1024;

/** Problems in the list of repository files ({ path, size }, paths with '/'). */
export function auditRepo(files) {
  const problems = [];
  for (const { path: rel, size } of files) {
    const ext = path.extname(rel).toLowerCase();
    if (BANNED_EXT.includes(ext)) problems.push(`${rel}: game asset format (${ext}) in the repository`);
    if ([...IMAGE_EXT, '.svg', '.ico'].includes(ext) && !REPO_IMAGE_OK.some((rx) => rx.test(rel)))
      problems.push(`${rel}: image outside public/ (favicon, og, portraits); renders and texture dumps stay in tools/local`);
    if (size > REPO_MAX_FILE && !REPO_BIG_OK.some((rx) => rx.test(rel))) problems.push(`${rel}: ${(size / 1048576).toFixed(1)} MB, larger than ${REPO_MAX_FILE / 1048576} MB`);
  }
  return problems;
}

/** Files git would commit: tracked plus untracked-but-not-ignored. null when git is not there. */
export function repoFiles(repo = REPO) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  return out
    .split('\0')
    .filter(Boolean)
    .map((rel) => {
      const f = path.join(repo, rel);
      return fs.existsSync(f) ? { path: rel, size: fs.statSync(f).size } : null;
    })
    .filter(Boolean);
}

/** CI must name the base path: with the default '/' the base check passes for any build. */
export function auditBaseGiven(env, baseArg) {
  if (!env.GITHUB_ACTIONS || baseArg !== undefined) return [];
  if (env.VITE_BASE !== undefined && env.VITE_BASE !== '') return [];
  return ['VITE_BASE is not set in CI: pass VITE_BASE=/<repo>/ (or --base) so the base-path check means something'];
}

/** index.html: local asset URLs under the base path, CSP present. */
export function auditIndex(html, base = '/') {
  const problems = [];
  const b = /^https?:\/\//.test(base) ? new URL(base).pathname : base;
  if (/["'\s=/][A-Za-z]:[\\/]|Program Files/.test(html)) problems.push('index.html: a Windows path leaked into the URLs (VITE_BASE rewritten by Git Bash?)');
  for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|data:|blob:|mailto:|#|%)/.test(u)) continue;
    if (b !== './' && !u.startsWith(b)) problems.push(`index.html: ${u} is outside the base path ${b}`);
  }
  if (!/http-equiv="Content-Security-Policy"/.test(html)) problems.push('index.html: no Content-Security-Policy meta tag');
  return problems;
}

/**
 * pack.ps1 (the one-liner's bootstrap, not a game file): stamped by the build with the commit
 * it downloads, plain ASCII. In CI the commit must be a full SHA, not the 'main' fallback.
 */
export function auditPackScript(text, { ci = false } = {}) {
  const problems = [];
  if (/__VMIRROR_(COMMIT|REPO|SITE)__/.test(text)) problems.push('pack.ps1: a __VMIRROR_*__ placeholder was not stamped by the build');
  const commit = /\$commit = '([^']*)'/.exec(text)?.[1];
  if (ci && !/^[0-9a-f]{40}$/.test(commit ?? '')) problems.push(`pack.ps1: the commit is ${commit ?? 'missing'}, expected the 40-hex SHA of the build`);
  if (/[^\x00-\x7e]/.test(text)) problems.push('pack.ps1: non-ASCII characters (PowerShell 5.1 and irm may read it as Latin-1)');
  return problems;
}

/** Returns the list of problems (empty = clean). */
export function auditDist(dist, { pack, base, ci = false } = {}) {
  const problems = [];
  if (!fs.existsSync(dist)) return [`${dist} does not exist (run the build first)`];
  const index = path.join(dist, 'index.html');
  if (fs.existsSync(index)) problems.push(...auditIndex(fs.readFileSync(index, 'utf8'), base ?? '/'));
  const ps1 = path.join(dist, 'pack.ps1');
  if (fs.existsSync(ps1)) problems.push(...auditPackScript(fs.readFileSync(ps1, 'utf8'), { ci }));
  const files = walk(dist);
  // pack files by size, to find byte copies cheaply
  const packBySize = new Map();
  if (pack && fs.existsSync(pack)) {
    for (const f of walk(pack)) {
      const s = fs.statSync(f).size;
      if (s < 4096) continue; // tiny JSON/LUTs: too generic to compare
      if (!packBySize.has(s)) packBySize.set(s, []);
      packBySize.get(s).push(f);
    }
  }
  for (const f of files) {
    const rel = path.relative(dist, f).split(path.sep).join('/');
    const ext = path.extname(f).toLowerCase();
    const size = fs.statSync(f).size;
    if (BANNED_EXT.includes(ext)) problems.push(`${rel}: game asset format (${ext})`);
    const top = rel.split('/')[0];
    if (rel.includes('/') && PACK_DIRS.includes(top)) problems.push(`${rel}: asset-pack folder "${top}/" must not be in the build`);
    if (rel === 'pack.json' || rel.endsWith('/pack.json')) problems.push(`${rel}: asset pack index in the build`);
    if (IMAGE_EXT.includes(ext)) {
      if (!IMAGE_OK.some((rx) => rx.test(rel))) problems.push(`${rel}: unexpected image (only app assets, portraits and MediaPipe are allowed)`);
      else if (size > MAX_IMAGE) problems.push(`${rel}: image larger than ${MAX_IMAGE / 1048576} MB`);
    }
    const same = packBySize.get(size);
    if (same) {
      const h = sha1(f);
      const hit = same.find((p) => sha1(p) === h);
      if (hit) problems.push(`${rel}: byte copy of the local pack file ${path.relative(pack, hit).split(path.sep).join('/')}`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--pack');
  const packArg = pi >= 0 && args[pi + 1] && !args[pi + 1].startsWith('--') ? args[pi + 1] : undefined;
  const pack = packArg ? path.resolve(packArg) : path.join(REPO, 'tools', 'local');
  const dist = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pack' && args[i - 1] !== '--base') ?? path.join(REPO, 'dist'));
  const bi = args.indexOf('--base');
  const baseArg = bi >= 0 ? args[bi + 1] : undefined;
  const rawBase = baseArg ?? process.env.VITE_BASE;
  let base;
  try {
    base = normalizeBase(rawBase);
  } catch (e) {
    console.error(`audit:dist: ${e.message}`);
    process.exit(2);
  }
  const problems = [...auditBaseGiven(process.env, baseArg), ...auditDist(dist, { pack, base, ci: !!process.env.GITHUB_ACTIONS })];
  const repo = repoFiles();
  if (repo) problems.push(...auditRepo(repo));
  else console.warn('audit:dist: git is not available, repository files not checked');
  if (problems.length) {
    console.error(`audit:dist FAILED: ${problems.length} problem(s) in ${dist}`);
    for (const p of problems.slice(0, 50)) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`audit:dist ok: ${walk(dist).length} files in ${path.relative(REPO, dist) || dist}${repo ? `, ${repo.length} repository files` : ''}, nothing from the game`);
}
