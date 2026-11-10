// Finds Cyberpunk 2077 installs on Windows (read-only): GOG, Steam and Epic launcher records,
// then a shallow scan of the fixed drives. Used by pack.mjs when --game is not given.
//
// The parsers (reg query output, Steam .vdf/.acf, Epic .item) are pure functions; the
// lookup takes its registry, file system and drive list from `deps`, so tests run on fixtures.
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

// Windows paths on every OS: the lookup is Windows-only, and tests on Linux CI use the same fixtures
const path = nodePath.win32;

export const GOG_ID = '1423049311';
export const STEAM_APP = '1091500';

// ------------------------------------------------------------------ parsers
/**
 * Output of `reg query <key> [/v name]` -> [{ key, name, type, value }].
 * The default value is reported as name '' ("(Default)" in English Windows, localised elsewhere).
 */
export function parseRegQuery(text) {
  const out = [];
  let key = '';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^HKEY_/i.test(raw)) {
      key = raw.trim();
      continue;
    }
    const m = /^\s+(.*?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?$/.exec(raw) ?? /^\s+(.*?)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(raw);
    if (!m) continue;
    const name = /^\(.*\)$/.test(m[1]) ? '' : m[1];
    out.push({ key, name, type: m[2], value: (m[3] ?? '').trimEnd() });
  }
  return out;
}

/** Value `name` (case-insensitive) from reg query output, or undefined. */
export function regValue(text, name) {
  const n = name.toLowerCase();
  return parseRegQuery(text).find((e) => e.name.toLowerCase() === n)?.value;
}

/** Valve KeyValues text (libraryfolders.vdf, appmanifest_*.acf) -> nested plain object. */
export function parseVdf(text) {
  const s = String(text ?? '');
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') i++;
        continue;
      }
      return;
    }
  };
  const token = () => {
    ws();
    if (i >= s.length) return null;
    const c = s[i];
    if (c === '{' || c === '}') {
      i++;
      return { brace: c };
    }
    if (c === '"') {
      i++;
      let v = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          v += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        } else v += s[i];
        i++;
      }
      i++;
      return { str: v };
    }
    let v = '';
    while (i < s.length && !/[\s{}"]/.test(s[i])) v += s[i++];
    return { str: v };
  };
  const obj = () => {
    const o = {};
    for (;;) {
      const k = token();
      if (!k || k.brace === '}') return o;
      if (k.brace) continue;
      const v = token();
      if (!v) return o;
      if (v.brace === '{') o[k.str] = obj();
      else if (v.brace === '}') return o;
      else o[k.str] = v.str;
      // conditional suffixes like [$WIN32] are ignored
      const save = i;
      ws();
      if (s[i] === '[') {
        while (i < s.length && s[i] !== ']') i++;
        i++;
      } else i = save;
    }
  };
  return obj();
}

const lowerKeys = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v])) : {});

/** Library folders listed in steamapps/libraryfolders.vdf (new and old formats). */
export function steamLibraries(vdfText) {
  const root = lowerKeys(parseVdf(vdfText));
  const lf = root.libraryfolders ?? root;
  const libs = [];
  for (const [k, v] of Object.entries(lowerKeys(lf))) {
    if (!/^\d+$/.test(k)) continue;
    if (typeof v === 'string') libs.push(v);
    else if (v && typeof v === 'object') {
      const p = lowerKeys(v).path;
      if (typeof p === 'string') libs.push(p);
    }
  }
  return libs;
}

/** installdir of an appmanifest_<id>.acf, or undefined. */
export function appManifestInstallDir(acfText) {
  const st = lowerKeys(lowerKeys(parseVdf(acfText)).appstate);
  return typeof st.installdir === 'string' && st.installdir ? st.installdir : undefined;
}

/** Epic launcher manifest (*.item, JSON) -> install folder when it is Cyberpunk 2077. */
export function epicInstallLocation(itemText) {
  let j;
  try {
    j = JSON.parse(String(itemText ?? '').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const names = [j.DisplayName, j.MandatoryAppFolderName, j.AppName].filter((x) => typeof x === 'string');
  if (!names.some((n) => /cyberpunk\s*2077/i.test(n))) return undefined;
  return typeof j.InstallLocation === 'string' && j.InstallLocation ? j.InstallLocation : undefined;
}

/** Dotted version compare: 1 when a is newer, -1 when older, 0 when equal or unknown. */
export function compareVersions(a, b) {
  const pa = String(a ?? '').match(/\d+/g)?.map(Number);
  const pb = String(b ?? '').match(/\d+/g)?.map(Number);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const x = pa[k] ?? 0;
    const y = pb[k] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * The install to use among valid candidates: one with the game exe first, then the newest
 * game version, then the newest exe, then the earliest found (launcher records come first).
 */
export function pickBest(cands) {
  if (!cands.length) return undefined;
  return [...cands]
    .map((c, order) => ({ c, order }))
    .sort((A, B) => {
      const a = A.c;
      const b = B.c;
      if (!!a.hasExe !== !!b.hasExe) return a.hasExe ? -1 : 1;
      const v = compareVersions(b.version, a.version);
      if (v) return v;
      if ((b.mtime ?? 0) !== (a.mtime ?? 0)) return (b.mtime ?? 0) - (a.mtime ?? 0);
      return A.order - B.order;
    })[0].c;
}

// ------------------------------------------------------------------ checks
/** A Cyberpunk 2077 folder: archive\pc\content holds basegame_*.archive. */
export function isGameDir(dir, fs = nodeFs) {
  try {
    const content = path.join(dir, 'archive', 'pc', 'content');
    return fs.readdirSync(content).some((n) => /^basegame_.*\.archive$/i.test(n));
  } catch {
    return false;
  }
}

/** Folders not worth listing in the drive scan (system, huge or protected). */
const SKIP = /^(\$.*|windows|system volume information|recovery|perflogs|config\.msi|msocache|documents and settings|programdata|users|intel|amd|nvidia|drivers|onedrivetemp|node_modules|\..*)$/i;
/** Folders on a drive root whose content is scanned two levels deep too. */
export const COMMON = ['Games', 'Program Files', 'Program Files (x86)', 'GOG Games', 'GOG Galaxy\\Games', 'SteamLibrary', 'XboxGames', 'Epic Games', 'EpicGames'];

function subdirs(fs, dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Folders the drive scan looks at (each one is then checked with isGameDir). */
export function scanDirs(roots, fs = nodeFs) {
  const seen = new Set();
  const out = [];
  const add = (d) => {
    const k = d.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(d);
    }
  };
  for (const root of roots) {
    // depth 1 and 2 from the drive root
    for (const a of subdirs(fs, root)) {
      add(a);
      for (const b of subdirs(fs, a)) add(b);
    }
    // depth 1 and 2 under the usual game folders, plus the launchers' own layouts
    for (const c of COMMON) {
      const base = path.join(root, c);
      for (const a of subdirs(fs, base)) {
        add(a);
        for (const b of subdirs(fs, a)) add(b);
      }
      for (const lib of [path.join(base, 'steamapps', 'common'), path.join(base, 'Steam', 'steamapps', 'common')]) for (const a of subdirs(fs, lib)) add(a);
    }
    for (const x of subdirs(fs, path.join(root, 'XboxGames'))) add(path.join(x, 'Content'));
  }
  return out;
}

// ------------------------------------------------------------------ lookup
function defaultReg(key) {
  const r = spawnSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

function defaultDrives() {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' } | ForEach-Object { $_.Name }"], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  const list = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z]:\\$/i.test(s));
  if (list.length) return list;
  // no PowerShell: every drive letter that answers
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => nodeFs.existsSync(d));
}

function defaultVersions(exes) {
  if (!exes.length) return {};
  const list = exes.map((e) => `'${e.replace(/'/g, "''")}'`).join(',');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `@(${list}) | ForEach-Object { $_ + '|' + (Get-Item -LiteralPath $_).VersionInfo.ProductVersion }`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  const out = {};
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const k = line.lastIndexOf('|');
    if (k > 0) out[line.slice(0, k).toLowerCase()] = line.slice(k + 1).trim();
  }
  return out;
}

/** Launcher records: [{ dir, source }] (not yet validated). */
export function launcherCandidates({ reg, fs = nodeFs, env = process.env }) {
  const out = [];
  const add = (dir, source) => dir && out.push({ dir: path.normalize(dir.replace(/\//g, '\\')), source });
  for (const hive of ['HKLM', 'HKCU'])
    for (const sw of ['SOFTWARE\\WOW6432Node', 'SOFTWARE']) add(regValue(reg(`${hive}\\${sw}\\GOG.com\\Games\\${GOG_ID}`), 'path'), 'GOG');
  // Steam: the client folder, its library folders, appmanifest -> steamapps/common/<installdir>
  const steamRoots = [
    regValue(reg('HKCU\\Software\\Valve\\Steam'), 'SteamPath'),
    regValue(reg('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam'), 'InstallPath'),
    regValue(reg('HKLM\\SOFTWARE\\Valve\\Steam'), 'InstallPath'),
  ].filter(Boolean);
  const libs = [];
  for (const r of steamRoots) {
    libs.push(r);
    try {
      libs.push(...steamLibraries(fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8')));
    } catch {
      /* no library list */
    }
  }
  const seenLib = new Set();
  for (const lib of libs) {
    const norm = path.normalize(lib.replace(/\//g, '\\'));
    if (seenLib.has(norm.toLowerCase())) continue;
    seenLib.add(norm.toLowerCase());
    try {
      const dir = appManifestInstallDir(fs.readFileSync(path.join(norm, 'steamapps', `appmanifest_${STEAM_APP}.acf`), 'utf8'));
      if (dir) add(path.join(norm, 'steamapps', 'common', dir), 'Steam');
    } catch {
      /* not in this library */
    }
  }
  add(regValue(reg(`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App ${STEAM_APP}`), 'InstallLocation'), 'Steam');
  // Epic: one JSON .item per installed game
  const epic = path.join(env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  try {
    for (const f of fs.readdirSync(epic)) {
      if (!/\.item$/i.test(f)) continue;
      try {
        add(epicInstallLocation(fs.readFileSync(path.join(epic, f), 'utf8')), 'Epic');
      } catch {
        /* unreadable manifest */
      }
    }
  } catch {
    /* no Epic launcher */
  }
  return out;
}

/**
 * Every valid install found: [{ dir, source, hasExe, version, mtime }], launcher records first.
 * deps: { reg(key) -> reg query text, fs, drives() -> ['C:\\', ...], versions(exes) -> {exeLower: version}, env, scan }
 */
export function findGameInstalls(deps = {}) {
  const fs = deps.fs ?? nodeFs;
  const reg = deps.reg ?? defaultReg;
  const env = deps.env ?? process.env;
  const found = [];
  const seen = new Set();
  const consider = (dir, source) => {
    const k = path.resolve(dir).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    if (!isGameDir(dir, fs)) return;
    const exe = path.join(dir, 'bin', 'x64', 'Cyberpunk2077.exe');
    let mtime = 0;
    let hasExe = false;
    try {
      mtime = fs.statSync(exe).mtimeMs;
      hasExe = true;
    } catch {
      /* no exe */
    }
    found.push({ dir: path.resolve(dir), source, hasExe, exe, mtime });
  };
  for (const c of launcherCandidates({ reg, fs, env })) consider(c.dir, c.source);
  if (deps.scan !== false && (!found.length || deps.scan === true)) {
    const drives = (deps.drives ?? defaultDrives)();
    for (const d of scanDirs(drives, fs)) consider(d, 'disk scan');
  }
  const versions = found.some((f) => f.hasExe) ? (deps.versions ?? defaultVersions)(found.filter((f) => f.hasExe).map((f) => f.exe)) : {};
  for (const f of found) f.version = versions[f.exe.toLowerCase()];
  return found;
}

/** The install pack.mjs should use, or undefined. */
export function findGame(deps = {}) {
  const all = findGameInstalls(deps);
  return { best: pickBest(all), all };
}
