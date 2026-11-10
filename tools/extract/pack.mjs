#!/usr/bin/env node
// Builds the V-Mirror asset pack from a local Cyberpunk 2077 install (read-only).
//
//   npm run pack                      (finds the game, writes Documents\V-Mirror pack)
//   npm run pack -- --game "D:\Games\Cyberpunk 2077" --out D:\v-mirror-pack
//
// Options:
//   --game <dir>        game install folder (has archive\pc\content); default: found via GOG,
//                       Steam, Epic or a scan of the fixed drives
//   --out <dir>         pack folder (empty or an older pack); default Documents\V-Mirror pack
//                       (%LOCALAPPDATA%\v-mirror\pack when there is no Documents folder)
//   --force             rebuild even when --out already holds a complete pack of this version
//   --wolvenkit <exe>   WolvenKit.CLI.exe; default: $WOLVENKIT, else downloaded from the
//                       official GitHub release into the user cache folder
//   --work <dir>        work folder (default <out>.work); removed at the end unless --keep-work
//   --keep-work         keep the work folder (debugging, faster re-runs with --skip-extract)
//   --skip-extract      reuse game files already extracted into --work
//   --no-webp           keep PNG textures (default converts large PNGs to lossless WebP)
//   --only <a,b>        run only these phases: extract,export,inputs,meshes,build,swatches,optimize,index
//   --python <cmd>      Python 3.10+ with numpy and Pillow (default $PYTHON, python, py -3)
//
// See docs/ASSET_PACK.md for the layout and what each phase does.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { findGame } from './findgame.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PACK_DIR = path.join(HERE, 'pack');
const BUILDERS = path.join(PACK_DIR, 'builders');
const WK_TAG = '9.1.1';
/** The Windows console build of that release and its SHA-256 (verified before it is unpacked and run). */
const WK_ASSET = 'WolvenKit.Console-9.1.1.zip';
const WK_SHA256 = 'a14eae46931251635256e7b209cd4aa998ae5039a5fbd506fefaab671bf7f451';
const PHASES = ['extract', 'export', 'inputs', 'meshes', 'build', 'swatches', 'optimize', 'index'];

// ------------------------------------------------------------------ args
function parseArgs(argv) {
  const o = { webp: true, keepWork: false, skipExtract: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === '--game') o.game = val();
    else if (a === '--out') o.out = val();
    else if (a === '--wolvenkit') o.wolvenkit = val();
    else if (a === '--work') o.work = val();
    else if (a === '--python') o.python = val();
    else if (a === '--only') o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--keep-work') o.keepWork = true;
    else if (a === '--skip-extract') o.skipExtract = true;
    else if (a === '--no-webp') o.webp = false;
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') {
      const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
      const end = head.findIndex((l) => !l.startsWith('//'));
      process.stdout.write(head.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
      process.exit(0);
    } else die(`unknown option ${a} (see --help)`, `неизвестный параметр ${a} (см. --help)`);
  }
  return o;
}

/** Stops with an error; `ru` is the same message in Russian (the likely first-run failures have one). */
function die(msg, ru) {
  console.error(`\npack: ${msg}`);
  if (ru) console.error(`pack: ${ru}`);
  process.exit(1);
}

let t0 = Date.now();
function step(msg) {
  const s = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
  console.log(`[${s}s] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, ...opts });
  if (r.error) throw r.error;
  return r;
}

// ------------------------------------------------------------------ hashing (game resource ids)
/** FNV-1a 64 of the lower-cased depot path: how the game addresses files in .archive. */
export function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s.toLowerCase(), 'utf8')) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

// ------------------------------------------------------------------ fs helpers
const mkdirp = (d) => fs.mkdirSync(d, { recursive: true });
const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** hard link (same volume) or copy */
function place(src, dst) {
  mkdirp(path.dirname(dst));
  if (fs.existsSync(dst)) fs.rmSync(dst);
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

/** lower-cased relative path -> absolute path for a tree */
function indexTree(root) {
  const m = new Map();
  for (const f of walk(root)) m.set(toPosix(path.relative(root, f)).toLowerCase(), f);
  return m;
}

const depotRel = (depot) => depot.replace(/\\/g, '/');
const stripExt = (p) => p.replace(/\.[^./\\]+$/, '');

// ------------------------------------------------------------------ prerequisites
/**
 * Python 3.10+ with numpy and Pillow. `flags` are the isolation flags the builders run with:
 * -E -s -B normally; without -s when numpy/Pillow live in the user site-packages
 * (pip install --user), which -s would hide.
 */
function findPython(pref) {
  const cands = pref ? [pref] : [process.env.PYTHON, 'python', 'python3', 'py -3'].filter(Boolean);
  const probe = 'import sys, numpy, PIL; print(sys.version_info[:2] >= (3, 10))';
  for (const c of cands) {
    // a full path may contain spaces ("C:\Program Files\Python312\python.exe")
    const [cmd, ...pre] = fs.existsSync(c) ? [c] : c.split(' ');
    for (const flags of [['-E', '-s', '-B'], ['-E', '-B']]) {
      const r = spawnSync(cmd, [...pre, ...flags, '-c', probe], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && r.stdout.trim() === 'True') return { cmd, pre, flags };
    }
  }
  die('Python 3.10+ with numpy and Pillow is required (pip install numpy pillow), or pass --python', 'нужен Python 3.10+ с numpy и Pillow (pip install numpy pillow) или параметр --python');
}

function cacheDir() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'v-mirror', 'wolvenkit');
}

async function getWolvenKit(opt) {
  const given = opt.wolvenkit || process.env.WOLVENKIT;
  let exe = given;
  if (!exe) {
    const dir = path.join(cacheDir(), WK_TAG);
    exe = path.join(dir, 'WolvenKit.CLI.exe');
    if (!fs.existsSync(exe)) {
      if (process.platform !== 'win32') die('WolvenKit CLI is a Windows program: run the pack on Windows, or pass --wolvenkit');
      step(`downloading WolvenKit CLI ${WK_TAG} from github.com/WolvenKit/WolvenKit/releases`);
      const rel = await fetch(`https://api.github.com/repos/WolvenKit/WolvenKit/releases/tags/${WK_TAG}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'v-mirror-pack' } });
      if (!rel.ok) die(`GitHub API ${rel.status}: download WolvenKit.Console manually and pass --wolvenkit`);
      // the Windows console build (WolvenKit.ConsoleLinux-* is the Linux one)
      const asset = (await rel.json()).assets.find((a) => /^WolvenKit\.Console-[\d.]+\.zip$/i.test(a.name));
      if (!asset) die('no WolvenKit.Console zip in that release: pass --wolvenkit');
      const zip = path.join(cacheDir(), asset.name);
      mkdirp(dir);
      const r = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'v-mirror-pack' } });
      if (!r.ok) die(`download failed: ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      // the archive is executed below: check it against the pinned hash (and GitHub's own digest)
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      const listed = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
      if (asset.name !== WK_ASSET || got !== WK_SHA256) die(`${asset.name}: SHA-256 ${got} does not match the pinned ${WK_ASSET} ${WK_SHA256}`);
      if (listed && listed !== got) die(`${asset.name}: SHA-256 ${got} does not match the release digest ${listed}`);
      fs.writeFileSync(zip, buf);
      // Windows' own bsdtar reads zip files (a GNU tar earlier in PATH does not)
      const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      let x = fs.existsSync(sysTar) ? run(sysTar, ['-xf', zip, '-C', dir]) : { status: 1, stderr: 'no tar.exe' };
      if (x.status !== 0)
        x = run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]);
      if (x.status !== 0) die(`cannot unpack ${zip}: ${x.stderr}`);
      fs.rmSync(zip);
      const found = walk(dir).find((f) => path.basename(f).toLowerCase() === 'wolvenkit.cli.exe');
      if (!found) die('WolvenKit.CLI.exe not found in the downloaded archive');
      exe = found;
    }
  }
  if (!fs.existsSync(exe)) die(`WolvenKit CLI not found: ${exe}`);
  if (given) {
    // A WolvenKit of the user's own (--wolvenkit / $WOLVENKIT): its appsettings.json is changed
    // below, so work on a private copy in the cache and leave the user's install as it is
    const src = path.dirname(path.resolve(given));
    const copy = path.join(cacheDir(), 'user-copy');
    const stamp = path.join(copy, '.source');
    const sig = `${src}|${fs.statSync(exe).size}|${Math.round(fs.statSync(exe).mtimeMs)}`;
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== sig) {
      step(`copying WolvenKit from ${src} into ${copy} (the original stays untouched)`);
      fs.rmSync(copy, { recursive: true, force: true });
      fs.cpSync(src, copy, { recursive: true });
      fs.writeFileSync(stamp, sig);
    }
    exe = path.join(copy, path.basename(exe));
  }
  const v = run(exe, ['--version']);
  const version = (v.stdout || '').trim().split(/\s+/).pop() || 'unknown';
  // meshes are exported as geometry only (materials come from the builders)
  const cfg = path.join(path.dirname(exe), 'appsettings.json');
  try {
    const j = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8').replace(/^\uFEFF/, '')) : {};
    if (j?.MeshExportArgs?.WithMaterials !== false) {
      j.MeshExportArgs = { ...(j.MeshExportArgs ?? {}), WithMaterials: false, ExportGarmentSupport: false };
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2));
      step(`WolvenKit: mesh export without materials (${cfg})`);
    }
  } catch (e) {
    die(`cannot update ${cfg}: ${e.message}`);
  }
  return { exe, version };
}

/**
 * Runs WolvenKit; the full output goes to <work>/wolvenkit.log. With tolerant=true a non-zero
 * exit is not fatal (hash-list extraction exits non-zero when some archives lack the files;
 * the caller checks the results itself).
 */
function wk(W, args, what, tolerant = false) {
  const r = run(W.exe, args);
  const out = (r.stdout || '') + (r.stderr || '');
  if (W.log) fs.appendFileSync(W.log, `\n===== ${what}: ${args.join(' ')}\n${out}`);
  const errs = out.split('\n').filter((l) => /\[\s*\d+:\s*(Error|Critical)\s*\]|Exception/.test(l));
  if (r.status !== 0 && !tolerant) die(`WolvenKit ${what} failed (exit ${r.status}):\n${errs.slice(0, 8).join('\n') || out.slice(-2000)}`);
  if (errs.length && !tolerant) console.warn(`  WolvenKit ${what}: ${errs.length} error line(s), e.g.\n  ${errs.slice(0, 3).join('\n  ')}`);
  return out;
}

function gameVersion(game) {
  if (process.platform !== 'win32') return 'unknown';
  const exe = path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe');
  if (!fs.existsSync(exe)) return 'unknown';
  const r = run('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`]);
  return (r.stdout || '').trim() || 'unknown';
}

// ------------------------------------------------------------------ phases
function allDepots(recipe) {
  const s = new Set();
  for (const k of Object.keys(recipe.textures)) s.add(k);
  for (const k of Object.keys(recipe.serialize)) s.add(k);
  for (const k of Object.keys(recipe.meshes)) s.add(k);
  for (const v of Object.values(recipe.pack)) s.add(v);
  for (const a of recipe.anims) s.add(a.src);
  for (const v of recipe.swatches ?? []) s.add(v);
  return [...s].sort();
}

function phaseExtract(ctx) {
  const { recipe, W, work, game } = ctx;
  const raw = path.join(work, 'raw');
  mkdirp(raw);
  const depots = allDepots(recipe);
  const hashes = path.join(work, 'hashes.txt');
  fs.writeFileSync(hashes, depots.map((d) => fnv1a64(d).toString()).join('\n') + '\n');
  step(`extracting ${depots.length} game files (read-only)`);
  for (const sub of ['content', 'ep1']) {
    const dir = path.join(game, 'archive', 'pc', sub);
    if (fs.existsSync(dir)) wk(W, ['extract', dir, '-o', raw, '--hash', hashes], `extract ${sub}`, true);
  }
  // files missing from WolvenKit's name list come out as <hash>.bin: put them at their depot path
  const byHash = new Map(depots.map((d) => [fnv1a64(d).toString(), d]));
  for (const f of fs.readdirSync(raw)) {
    const m = /^(\d+)\.bin$/.exec(f);
    const d = m && byHash.get(m[1]);
    if (!d) continue;
    const dst = path.join(raw, depotRel(d));
    mkdirp(path.dirname(dst));
    fs.renameSync(path.join(raw, f), dst);
  }
  const idx = indexTree(raw);
  const missing = depots.filter((d) => !idx.has(depotRel(d).toLowerCase()));
  if (missing.length)
    die(
      `${missing.length} game files not found (other game version?):\n  ${missing.slice(0, 20).join('\n  ')}`,
      `в игре не найдено файлов: ${missing.length} (другая версия игры? набор рассчитан на патч 2.x)`,
    );
}

const KIND = (depot) => {
  const e = path.extname(depot).toLowerCase();
  if (e === '.xbm' || e === '.mlmask') return 'tex';
  if (e === '.mesh' || e === '.morphtarget') return 'mesh';
  if (e === '.anims') return 'anim';
  return 'other';
};

function phaseExport(ctx) {
  const { recipe, W, work, game } = ctx;
  const raw = path.join(work, 'raw');
  const idx = indexTree(raw);
  const stage = (name, depots) => {
    const d = path.join(work, 'stage', name);
    fs.rmSync(d, { recursive: true, force: true });
    for (const dep of depots) place(idx.get(depotRel(dep).toLowerCase()), path.join(d, depotRel(dep)));
    return d;
  };
  const tex = new Set(Object.keys(recipe.textures));
  for (const s of recipe.swatches ?? []) if (KIND(s) === 'tex') tex.add(s);
  const meshes = new Set([...Object.keys(recipe.meshes), ...Object.values(recipe.pack)]);
  const anims = new Set(recipe.anims.map((a) => a.src));
  const ser = new Set([...Object.keys(recipe.serialize), ...(recipe.swatches ?? []).filter((s) => KIND(s) === 'other')]);

  for (const [name, set, args] of [
    ['tex', tex, ['--uext', 'png']],
    ['mesh', meshes, []],
    ['anim', anims, []],
  ]) {
    const src = stage(name, set);
    const out = path.join(work, 'exp', name);
    fs.rmSync(out, { recursive: true, force: true });
    mkdirp(out);
    step(`exporting ${set.size} ${name} files`);
    wk(W, ['export', src, '-o', out, '--gamepath', game, ...args, '-v', 'Minimal'], `export ${name}`);
  }
  // `convert serialize` writes flat file names: stage every file under a unique flat name
  // (depot path with '~' for '\') and move the JSON back to <ser>/<depot>.json afterwards
  const flat = (dep) => depotRel(dep).replace(/\//g, '~');
  const sdir = path.join(work, 'stage', 'ser');
  fs.rmSync(sdir, { recursive: true, force: true });
  mkdirp(sdir);
  for (const dep of ser) place(idx.get(depotRel(dep).toLowerCase()), path.join(sdir, flat(dep)));
  const tmp = path.join(work, 'ser.flat');
  const out = path.join(work, 'ser');
  for (const d of [tmp, out]) {
    fs.rmSync(d, { recursive: true, force: true });
    mkdirp(d);
  }
  step(`serializing ${ser.size} resources to JSON`);
  wk(W, ['convert', 'serialize', sdir, '-o', tmp, '-v', 'Minimal'], 'serialize');
  const made = new Map(fs.readdirSync(tmp).map((f) => [f.toLowerCase(), f]));
  const lost = [];
  for (const dep of ser) {
    const f = made.get((flat(dep) + '.json').toLowerCase());
    if (!f) {
      lost.push(dep);
      continue;
    }
    const dst = path.join(out, depotRel(dep) + '.json');
    mkdirp(path.dirname(dst));
    fs.renameSync(path.join(tmp, f), dst);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (lost.length) die(`WolvenKit did not serialize ${lost.length} files, e.g.\n  ${lost.slice(0, 10).join('\n  ')}`);
}

/** file WolvenKit produced for a recipe work path */
function exportedFor(ctx, kind, depot, workPath) {
  const { work } = ctx;
  if (kind === 'tex') {
    const m = /\/((?:base|engine|ep1)\/.+)$/.exec(workPath);
    // depot-shaped work paths keep the exporter's own naming (mlmask layers: <n>_layers/<n>_<i>.png)
    const rel = m ? m[1] : stripExt(depotRel(depot)) + '.png';
    return path.join(work, 'exp', 'tex', rel);
  }
  if (kind === 'ser') return path.join(work, 'ser', depotRel(depot) + '.json');
  if (kind === 'mesh') return path.join(work, 'exp', 'mesh', path.dirname(depotRel(depot)), path.basename(workPath));
  throw new Error(kind);
}

function meshGlb(ctx, depot) {
  const d = depotRel(depot);
  const name = d.endsWith('.morphtarget') ? path.basename(d) + '.glb' : path.basename(stripExt(d)) + '.glb';
  return path.join(ctx.work, 'exp', 'mesh', path.dirname(d), name);
}

function existing(ctx, f) {
  if (fs.existsSync(f)) return f;
  // WolvenKit may keep the archive's own case
  const rel = toPosix(path.relative(ctx.work, f)).toLowerCase();
  ctx.workIndex ??= indexTree(ctx.work);
  const hit = ctx.workIndex.get(rel);
  if (hit) return hit;
  return null;
}

function phaseInputs(ctx) {
  const { recipe, work, out } = ctx;
  step('placing builder inputs');
  ctx.workIndex = null;
  const missing = [];
  for (const [kind, table] of [
    ['tex', recipe.textures],
    ['ser', recipe.serialize],
    ['mesh', recipe.meshes],
  ]) {
    for (const [depot, paths] of Object.entries(table)) {
      for (const wp of paths) {
        const src = existing(ctx, exportedFor(ctx, kind, depot, wp));
        if (!src) {
          missing.push(`${wp}  <-  ${depot}`);
          continue;
        }
        place(src, path.join(work, wp));
      }
    }
  }
  if (missing.length) die(`${missing.length} exported files are missing:\n  ${missing.slice(0, 20).join('\n  ')}`);
  for (const [dst, d] of Object.entries(recipe.data)) {
    const json = zlib.gunzipSync(fs.readFileSync(path.join(PACK_DIR, 'data', d.from)));
    const target = dst.startsWith('@') ? path.join(out, dst.slice(1)) : path.join(work, dst);
    mkdirp(path.dirname(target));
    fs.writeFileSync(target, json);
  }
}

function phaseMeshes(ctx) {
  const { recipe, out, work } = ctx;
  step(`copying ${Object.keys(recipe.pack).length} meshes into the pack`);
  for (const [dst, depot] of Object.entries(recipe.pack)) {
    const src = existing(ctx, meshGlb(ctx, depot));
    if (!src) die(`mesh export missing for ${depot}`);
    place(src, path.join(out, dst));
  }
  step('character-creator animations');
  for (const a of recipe.anims) {
    const src = existing(ctx, path.join(work, 'exp', 'anim', depotRel(a.src) + '.glb'));
    if (!src) die(`animation export missing for ${a.src}`);
    mkdirp(path.dirname(path.join(out, a.out)));
    const rx = '^(' + a.keep.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$';
    const r = run(process.execPath, [path.join(BUILDERS, 'body', 'glb_subset.mjs'), src, path.join(out, a.out), rx]);
    if (r.status !== 0) die(`glb_subset failed: ${r.stderr}`);
  }
  step('joint reports (glbinfo)');
  for (const [dst, s] of Object.entries(recipe.glbinfo)) {
    const glb = s.work ? path.join(work, s.work) : path.join(out, s.pack);
    const target = path.join(work, dst);
    mkdirp(path.dirname(target));
    const r = run(process.execPath, [path.join(BUILDERS, 'body', 'glbinfo.mjs'), path.basename(glb), '--joints', '--json', target], { cwd: path.dirname(glb) });
    if (r.status !== 0 || !fs.existsSync(target)) die(`glbinfo failed for ${glb}: ${r.stderr}`);
  }
}

function phaseBuild(ctx) {
  const { recipe, py, work, out } = ctx;
  const env = { ...process.env, VM_WORK: work, VM_OUT: out, VM_REPO: REPO, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const s of recipe.steps) {
    step(`builder ${s}`);
    const r = spawnSync(py.cmd, [...py.pre, ...py.flags,path.join(BUILDERS, s)], { env, cwd: work, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
    fs.appendFileSync(path.join(work, 'builders.log'), `\n===== ${s}\n${r.stdout}\n${r.stderr}`);
    if (r.status !== 0) die(`builder ${s} failed (log: ${path.join(work, 'builders.log')}):\n${(r.stderr || '').slice(-3000)}`);
  }
}

function phaseSwatches(ctx) {
  const { recipe, py, work, out, game } = ctx;
  const script = path.join(HERE, 'build_swatches.py');
  if (!fs.existsSync(script) || !recipe.swatchesInputs) {
    step('swatches: skipped (no build_swatches.py)');
    return;
  }
  // build_swatches.py reads the creator thumbnail atlas the way extract_game_data.ps1 lays it out
  const sw = path.join(work, 'swatches');
  for (const [dst, src] of Object.entries(recipe.swatchesInputs)) {
    const f = existing(ctx, path.join(work, src));
    if (!f) die(`swatches input missing: ${src}`);
    place(f, path.join(sw, dst));
  }
  step('swatches (build_swatches.py)');
  // the colour facts (swatches.{male,female}.json) are committed in src/data; the pack run
  // writes its own copy into the work folder so the repository is never touched
  fs.mkdirSync(path.join(sw, 'data'), { recursive: true });
  const r = spawnSync(py.cmd, [...py.pre, ...py.flags,script, '--game', game, '--work', sw, '--pack', out, '--data', path.join(sw, 'data')], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  fs.appendFileSync(path.join(work, 'builders.log'), `\n===== swatches\n${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) die(`build_swatches.py failed:\n${(r.stderr || '').slice(-2000)}`);
}

function phaseOptimize(ctx) {
  const { py, out } = ctx;
  if (!ctx.opt.webp) return step('optimize: skipped (--no-webp)');
  step('optimize: large PNG textures -> lossless WebP, manifests updated');
  const r = spawnSync(py.cmd, [...py.pre, ...py.flags,path.join(PACK_DIR, 'optimize.py'), out], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  process.stdout.write(r.stdout);
  if (r.status !== 0) die(`optimize failed:\n${r.stderr}`);
}

/** Expected pack files (recipe.expect) that `files` (pack-relative, '/') lacks; .png may be .webp. */
export function lackingFiles(files, expect) {
  const all = new Set(files);
  const have = new Set(files.map((f) => f.replace(/\.webp$/, '')));
  return expect.filter((f) => !have.has(f.replace(/\.(png|webp)$/, '')) && !all.has(f));
}

function phaseIndex(ctx) {
  const { recipe, out } = ctx;
  const files = walk(out).map((f) => toPosix(path.relative(out, f))).filter((f) => f !== 'pack.json');
  const lacking = lackingFiles(files, recipe.expect);
  const bytes = walk(out).reduce((s, f) => s + fs.statSync(f).size, 0);
  // a re-index without --game (e.g. `npm run pack:optimize`) keeps what the full build recorded
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  } catch {
    /* first index */
  }
  const wkPrev = /WolvenKit ([^)]+)\)/.exec(prev.tool ?? '')?.[1];
  const manifest = {
    format: 1,
    gameVersion: ctx.gameVersion ?? (ctx.game ? gameVersion(ctx.game) : prev.gameVersion ?? 'unknown'),
    createdAt: new Date().toISOString(),
    files: files.length,
    bytes,
    tool: `${toolName()} (WolvenKit ${ctx.W?.version ?? wkPrev ?? 'n/a'})`,
    // which recipe built it: a later run of the same version skips a complete pack
    recipe: recipeId(),
  };
  fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify(manifest, null, 1) + '\n');
  step(`pack.json: ${files.length} files, ${(bytes / 1e6).toFixed(0)} MB`);
  if (lacking.length) {
    console.warn(`  ${lacking.length} expected files are missing:\n  ${lacking.slice(0, 30).join('\n  ')}`);
    process.exitCode = 2;
  }
}

// ------------------------------------------------------------------ defaults and re-runs
/** "v-mirror <package version>": the tool part of pack.json without the WolvenKit version. */
export function toolName() {
  return `v-mirror ${JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version}`;
}

/** Short hash of the recipe and builder data: packs built from the same inputs share it. */
export function recipeId() {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(path.join(PACK_DIR, 'recipe.json')));
  for (const f of [...walk(BUILDERS), ...walk(path.join(PACK_DIR, 'data')), path.join(PACK_DIR, 'optimize.py'), path.join(HERE, 'build_swatches.py')].sort()) {
    if (!fs.existsSync(f) || /__pycache__|\.pyc$/.test(f)) continue;
    h.update(toPosix(path.relative(PACK_DIR, f)));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Default pack folder: %USERPROFILE%\Documents\V-Mirror pack, or %LOCALAPPDATA%\v-mirror\pack
 * when that Documents folder does not exist (OneDrive's folder backup moves Documents into
 * %USERPROFILE%\OneDrive) or is a link into OneDrive (the pack is ~600 MB of game files: they
 * must not be uploaded anywhere). The site names both (src/config.ts PACK_ALT_DIR).
 */
export function defaultOutDir({ env = process.env, platform = process.platform, exists = fs.existsSync, realpath = (p) => fs.realpathSync.native(p), home = os.homedir() } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const profile = env.USERPROFILE || home;
  const docs = P.join(profile, 'Documents');
  let real = docs;
  try {
    real = realpath(docs);
  } catch {
    /* keep the plain path */
  }
  if (exists(docs) && !/[\\/]OneDrive/i.test(real)) return P.join(docs, 'V-Mirror pack');
  const local = platform === 'win32' ? env.LOCALAPPDATA || P.join(profile, 'AppData', 'Local') : env.XDG_DATA_HOME || P.join(profile, '.local', 'share');
  return P.join(local, 'v-mirror', 'pack');
}

/**
 * Whether `manifest` (pack.json) + `files` (pack-relative) is a complete pack built by this
 * tool version from this recipe (and, when both are known, the same game version).
 */
export function packCompleteness(manifest, files, { tool, recipe, expect, gameVersion }) {
  if (!manifest || typeof manifest !== 'object' || manifest.format !== 1) return { complete: false, reason: 'no valid pack.json' };
  if (typeof manifest.tool !== 'string' || !(manifest.tool === tool || manifest.tool.startsWith(tool + ' '))) return { complete: false, reason: `built by ${manifest.tool ?? 'an unknown tool'}, this is ${tool}` };
  if (manifest.recipe !== recipe) return { complete: false, reason: 'built from another recipe' };
  if (gameVersion && gameVersion !== 'unknown' && manifest.gameVersion && manifest.gameVersion !== 'unknown' && manifest.gameVersion !== gameVersion)
    return { complete: false, reason: `built from game ${manifest.gameVersion}, the game is now ${gameVersion}` };
  const lacking = lackingFiles(files, expect);
  if (lacking.length) return { complete: false, reason: `${lacking.length} files are missing` };
  return { complete: true };
}

function readPackState(out, ctx) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8'));
  } catch {
    return { complete: false, reason: 'no valid pack.json' };
  }
  const files = walk(out).map((f) => toPosix(path.relative(out, f))).filter((f) => f !== 'pack.json');
  return packCompleteness(manifest, files, { tool: toolName(), recipe: recipeId(), expect: ctx.recipe.expect, gameVersion: ctx.gameVersion });
}

/** pack.ps1 reads the finished pack folder from here (VMIRROR_RESULT_FILE), UTF-8. */
function writeResult(out) {
  const f = process.env.VMIRROR_RESULT_FILE;
  if (f) fs.writeFileSync(f, out, 'utf8');
}

function finish(out) {
  writeResult(out);
  console.log(`\nPack folder: ${out}`);
  // run by pack.ps1 (it prints the instruction in both languages and opens the site)
  if (!process.env.VMIRROR_RESULT_FILE) console.log('Open V-Mirror, press "Choose pack folder" and select this folder.');
}

const GAME_NOT_FOUND = [
  [
    'Cyberpunk 2077 was not found. Name the game folder (the one with archive\\pc\\content) and run again:',
    "  PowerShell one-liner:  $env:VMIRROR_GAME = 'D:\\Games\\Cyberpunk 2077'   then paste the command again",
    '  pack.ps1 -Game "D:\\Games\\Cyberpunk 2077"   or   npm run pack -- --game "D:\\Games\\Cyberpunk 2077"',
  ].join('\n'),
  [
    'Cyberpunk 2077 не найдена. Укажите папку игры (ту, где есть archive\\pc\\content) и запустите снова:',
    "  для команды PowerShell:  $env:VMIRROR_GAME = 'D:\\Games\\Cyberpunk 2077'   затем вставьте команду ещё раз",
  ].join('\n'),
];

// ------------------------------------------------------------------ main
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const out = path.resolve(opt.out ?? defaultOutDir());
  if (!opt.out) console.log(`pack folder (default): ${out}`);
  const only = opt.only ?? PHASES;
  for (const p of only) if (!PHASES.includes(p)) die(`unknown phase ${p}`);
  const need = (p) => only.includes(p) && !(p === 'extract' && opt.skipExtract);
  const gamePhases = ['extract', 'export', 'inputs', 'meshes', 'build', 'swatches'].some((p) => need(p));
  const recipe = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'recipe.json'), 'utf8'));
  // a second run (the one-liner pasted again) does not rebuild a finished pack
  const mayKeep = !opt.force && !opt.only && fs.existsSync(path.join(out, 'pack.json'));
  if (gamePhases && !opt.game) {
    if (process.platform !== 'win32') die('--game is required outside Windows (see --help)');
    console.log('looking for Cyberpunk 2077 (GOG, Steam, Epic, then the fixed drives)...');
    const { best, all } = findGame();
    if (!best) {
      // the game was moved or uninstalled after a complete build: the pack itself still works
      if (mayKeep && readPackState(out, { recipe }).complete) {
        step(`Cyberpunk 2077 was not found, but the pack in ${out} is complete (${toolName()}; its game version was not checked): nothing to rebuild`);
        return finish(out);
      }
      die(...GAME_NOT_FOUND);
    }
    for (const g of all) console.log(`  ${g === best ? '*' : ' '} ${g.dir}  (${g.source}${g.version ? `, version ${g.version}` : ''})`);
    if (all.length > 1) console.log('  using the one marked *; pass --game to choose another');
    opt.game = best.dir;
  }
  const game = opt.game ? path.resolve(opt.game) : undefined;
  if (game && !fs.existsSync(path.join(game, 'archive', 'pc', 'content')))
    die(`not a Cyberpunk 2077 folder (no archive\\pc\\content): ${game}`, `это не папка Cyberpunk 2077 (нет archive\\pc\\content): ${game}`);
  const inGame = (p) => {
    const r = path.relative(game, p);
    return !r || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  if (game && (inGame(out) || (opt.work && inGame(path.resolve(opt.work))))) die('--out and --work must be outside the game folder (the game is never written to)');
  // an interrupted run leaves a pack without pack.json: accept a folder that holds only pack entries
  const PACK_ENTRIES = new Set(['pack.json', 'glb', 'hair', 'tex', 'body', 'swatches', 'renders']);
  const looksLikePack = (d) => fs.existsSync(path.join(d, 'pack.json')) || fs.readdirSync(d).every((n) => PACK_ENTRIES.has(n));
  if (gamePhases && fs.existsSync(out) && fs.readdirSync(out).length && !looksLikePack(out) && path.resolve(out) !== path.join(REPO, 'tools', 'local'))
    die(`--out is not empty and is not an asset pack: ${out}`, `папка набора не пуста и не похожа на набор ассетов: ${out}`);
  const work = path.resolve(opt.work ?? out + '.work');
  const ctx = { opt, out, work, game, recipe };
  t0 = Date.now();
  if (game) ctx.gameVersion = gameVersion(game);

  if (mayKeep) {
    const st = readPackState(out, ctx);
    if (st.complete) {
      step(`the pack in ${out} is already complete (${toolName()}, game ${ctx.gameVersion ?? 'unknown'}): nothing to rebuild (--force rebuilds it)`);
      return finish(out);
    }
    step(`rebuilding the pack in ${out}: ${st.reason}`);
  }
  if (!opt.only) step('building the pack: usually 5-10 minutes (the first run also downloads WolvenKit CLI)');

  mkdirp(out);
  mkdirp(work);
  if (gamePhases || need('optimize')) ctx.py = findPython(opt.python);
  if (['extract', 'export'].some((p) => need(p))) {
    ctx.W = await getWolvenKit(opt);
    ctx.W.log = path.join(work, 'wolvenkit.log');
  }
  step(`game ${ctx.gameVersion ?? '-'}${game ? ` (${game}, read-only)` : ''}; pack ${out}; work ${work}`);

  const phases = { extract: phaseExtract, export: phaseExport, inputs: phaseInputs, meshes: phaseMeshes, build: phaseBuild, swatches: phaseSwatches, optimize: phaseOptimize, index: phaseIndex };
  const todo = PHASES.filter((p) => need(p));
  todo.forEach((p, k) => {
    console.log(`== ${k + 1}/${todo.length} ${p}`);
    phases[p](ctx);
  });
  if (!opt.keepWork && !opt.only) {
    step('removing the work folder');
    fs.rmSync(work, { recursive: true, force: true });
  }
  step(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  if (!process.exitCode) finish(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => die(e.stack || String(e)));
}
