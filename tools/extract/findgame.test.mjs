import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  appManifestInstallDir,
  compareVersions,
  epicInstallLocation,
  findGame,
  findGameInstalls,
  isGameDir,
  parseRegQuery,
  parseVdf,
  pickBest,
  regValue,
  scanDirs,
  steamLibraries,
} from './findgame.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

/**
 * In-memory file system with Windows paths (case-insensitive, like NTFS): the lookup never
 * touches the real disk or registry in tests, and runs the same on Linux CI.
 * files: { 'C:\\a\\b.txt': 'content' | { content, mtimeMs } }
 */
function fakeFs(files) {
  const W = path.win32;
  const file = new Map();
  const kids = new Map(); // dir lower -> Map(name lower -> { name, dir })
  const addKid = (dir, name, isDir) => {
    const k = dir.toLowerCase();
    if (!kids.has(k)) kids.set(k, new Map());
    const m = kids.get(k);
    if (!m.has(name.toLowerCase())) m.set(name.toLowerCase(), { name, dir: isDir });
  };
  for (const [p, v] of Object.entries(files)) {
    const full = W.normalize(p);
    file.set(full.toLowerCase(), typeof v === 'string' ? { content: v, mtimeMs: 1 } : v);
    let cur = full;
    let isDir = false;
    for (;;) {
      const parent = W.dirname(cur);
      if (parent === cur) break;
      addKid(parent, W.basename(cur), isDir);
      cur = parent;
      isDir = true;
    }
  }
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const norm = (p) => W.normalize(String(p)).replace(/\\$/, (m, i, s) => (/^[A-Za-z]:\\$/.test(s) ? m : '')).toLowerCase();
  return {
    readdirSync(dir, opts) {
      const m = kids.get(norm(dir)) ?? kids.get(norm(dir) + '\\');
      if (!m) throw enoent(dir);
      const list = [...m.values()];
      return opts?.withFileTypes ? list.map((e) => ({ name: e.name, isDirectory: () => e.dir, isFile: () => !e.dir })) : list.map((e) => e.name);
    },
    readFileSync(p) {
      const f = file.get(norm(p));
      if (!f) throw enoent(p);
      return f.content;
    },
    statSync(p) {
      const f = file.get(norm(p));
      if (!f) throw enoent(p);
      return { mtimeMs: f.mtimeMs ?? 1, isFile: () => true };
    },
  };
}

/** files of a valid game folder */
const game = (dir, { exe = true, mtimeMs = 1 } = {}) => ({
  [`${dir}\\archive\\pc\\content\\basegame_1_engine.archive`]: '',
  [`${dir}\\archive\\pc\\content\\basegame_4_appearance.archive`]: '',
  ...(exe ? { [`${dir}\\bin\\x64\\Cyberpunk2077.exe`]: { content: '', mtimeMs } } : {}),
});

const noReg = () => '';

describe('findgame: parsers', () => {
  it('reads reg query output (values, empty values, the default value)', () => {
    const rows = parseRegQuery(fixture('reg-gog.txt'));
    expect(rows[0].key).toBe('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1423049311');
    expect(rows.find((r) => r.name === 'path')).toMatchObject({ type: 'REG_SZ', value: 'F:\\GOG Games\\Cyberpunk 2077' });
    expect(rows.find((r) => r.name === 'launchCommand')?.value).toBe('"F:\\GOG Games\\Cyberpunk 2077\\REDprelauncher.exe"');
    expect(rows.find((r) => r.name === 'dependsOn')?.value).toBe('');
    expect(rows.some((r) => r.name === '')).toBe(true);
    expect(regValue(fixture('reg-gog.txt'), 'PATH')).toBe('F:\\GOG Games\\Cyberpunk 2077');
    expect(regValue(fixture('reg-steam.txt'), 'SteamPath')).toBe('c:/program files (x86)/steam');
    expect(regValue(fixture('reg-steam.txt'), 'RunningAppID')).toBe('0x0');
    expect(regValue('', 'path')).toBeUndefined();
    expect(regValue('ERROR: The system was unable to find the specified registry key or value.', 'path')).toBeUndefined();
  });

  it('parses Valve KeyValues: nesting, escapes, comments', () => {
    const v = parseVdf(fixture('libraryfolders.vdf'));
    expect(v.libraryfolders['1'].label).toBe('Games "SSD"');
    expect(v.libraryfolders['1'].apps['1091500']).toBe('70000000000');
    expect(parseVdf('"a" { "b" "c" } "d" "e"')).toEqual({ a: { b: 'c' }, d: 'e' });
    expect(parseVdf('')).toEqual({});
  });

  it('lists Steam libraries in the new and the old libraryfolders.vdf format', () => {
    expect(steamLibraries(fixture('libraryfolders.vdf'))).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
    const old = '"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1600000000"\n\t"ContentStatsID"\t\t"-1"\n\t"1"\t\t"E:\\\\Games\\\\Steam"\n}\n';
    expect(steamLibraries(old)).toEqual(['E:\\Games\\Steam']);
    expect(steamLibraries('garbage')).toEqual([]);
  });

  it('reads installdir of the Steam app manifest', () => {
    expect(appManifestInstallDir(fixture('appmanifest_1091500.acf'))).toBe('Cyberpunk 2077');
    expect(appManifestInstallDir('"AppState" { "appid" "1" }')).toBeUndefined();
  });

  it('takes InstallLocation only from the Cyberpunk 2077 Epic manifest', () => {
    expect(epicInstallLocation(fixture('epic-cyberpunk.item'))).toBe('E:\\Epic Games\\Cyberpunk2077');
    expect(epicInstallLocation('\uFEFF' + fixture('epic-cyberpunk.item'))).toBe('E:\\Epic Games\\Cyberpunk2077');
    expect(epicInstallLocation(fixture('epic-other.item'))).toBeUndefined();
    expect(epicInstallLocation('{ not json')).toBeUndefined();
    expect(epicInstallLocation('null')).toBeUndefined();
  });
});

describe('findgame: choosing an install', () => {
  it('compares dotted versions', () => {
    expect(compareVersions('2.31', '2.3')).toBe(1);
    expect(compareVersions('2.3', '2.21')).toBe(-1);
    expect(compareVersions('3.0.79.10440', '2.31')).toBe(1);
    expect(compareVersions('2.5', '2.5.0')).toBe(0);
    expect(compareVersions(undefined, '2.0')).toBe(-1);
    expect(compareVersions('2.0', undefined)).toBe(1);
    expect(compareVersions(undefined, undefined)).toBe(0);
  });

  it('prefers a folder with the game exe, then the newest version, then the newest exe', () => {
    expect(pickBest([])).toBeUndefined();
    const a = { dir: 'A', hasExe: false, version: '9.9' };
    const b = { dir: 'B', hasExe: true, version: '2.3', mtime: 5 };
    const c = { dir: 'C', hasExe: true, version: '2.31', mtime: 1 };
    const d = { dir: 'D', hasExe: true, version: '2.31', mtime: 9 };
    expect(pickBest([a, b]).dir).toBe('B');
    expect(pickBest([a, b, c]).dir).toBe('C');
    expect(pickBest([c, d]).dir).toBe('D');
    // full tie: the first found (launcher records come before the drive scan)
    expect(pickBest([{ dir: 'X', hasExe: true }, { dir: 'Y', hasExe: true }]).dir).toBe('X');
  });

  it('validates a folder by archive\\pc\\content\\basegame_*.archive', () => {
    const fs = fakeFs({ ...game('G:\\Cyberpunk'), 'H:\\Fake\\archive\\pc\\content\\lang_en_voice.archive': '', 'H:\\Other\\readme.txt': '' });
    expect(isGameDir('G:\\Cyberpunk', fs)).toBe(true);
    expect(isGameDir('g:\\cyberpunk', fs)).toBe(true);
    expect(isGameDir('H:\\Fake', fs)).toBe(false);
    expect(isGameDir('H:\\Other', fs)).toBe(false);
    expect(isGameDir('Z:\\missing', fs)).toBe(false);
  });
});

describe('findgame: lookup', () => {
  const steamFiles = {
    'c:\\program files (x86)\\steam\\steamapps\\libraryfolders.vdf': fixture('libraryfolders.vdf'),
    'D:\\SteamLibrary\\steamapps\\appmanifest_1091500.acf': fixture('appmanifest_1091500.acf'),
  };
  const epicFiles = {
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\A1.item': fixture('epic-cyberpunk.item'),
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\B2.item': fixture('epic-other.item'),
  };
  const reg = (key) => {
    if (key === 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1423049311') return fixture('reg-gog.txt');
    if (key === 'HKCU\\Software\\Valve\\Steam') return fixture('reg-steam.txt');
    return '';
  };

  it('finds GOG, Steam and Epic installs from launcher records and picks the newest', () => {
    const fs = fakeFs({
      ...steamFiles,
      ...epicFiles,
      ...game('F:\\GOG Games\\Cyberpunk 2077'),
      ...game('D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077'),
      // Epic manifest points at a folder without the game archives (moved or uninstalled)
      'E:\\Epic Games\\Cyberpunk2077\\readme.txt': '',
    });
    let scanned = false;
    const versions = (exes) =>
      Object.fromEntries(exes.map((e) => [e.toLowerCase(), e.startsWith('F:') ? '2.3' : '2.31']));
    const { best, all } = findGame({ reg, fs, env: { ProgramData: 'C:\\ProgramData' }, versions, drives: () => ((scanned = true), []) });
    expect(all.map((g) => [g.dir, g.source, g.version])).toEqual([
      ['F:\\GOG Games\\Cyberpunk 2077', 'GOG', '2.3'],
      ['D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077', 'Steam', '2.31'],
    ]);
    expect(best.dir).toBe('D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077');
    expect(scanned).toBe(false); // launcher records found something: no drive scan
  });

  it('finds an Epic install', () => {
    const fs = fakeFs({ ...epicFiles, ...game('E:\\Epic Games\\Cyberpunk2077') });
    const all = findGameInstalls({ reg: noReg, fs, env: { ProgramData: 'C:\\ProgramData' }, versions: () => ({}), drives: () => [] });
    expect(all.map((g) => [g.dir, g.source])).toEqual([['E:\\Epic Games\\Cyberpunk2077', 'Epic']]);
  });

  it('falls back to a scan of the fixed drives (two levels deep, plus the usual game folders)', () => {
    const fs = fakeFs({
      ...game('G:\\Cyberpunk.2077.GOG.Rip-InsaneRamZes', { mtimeMs: 50 }),
      ...game('C:\\Games\\Cyberpunk 2077', { mtimeMs: 10 }),
      ...game('D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077', { mtimeMs: 20 }),
      ...game('F:\\Stuff\\old\\Cyberpunk 2077'), // depth 3: not scanned
      ...game('C:\\Windows\\Temp\\Cyberpunk'), // system folder: not scanned
      'C:\\$Recycle.Bin\\x\\archive\\pc\\content\\basegame_1.archive': '',
    });
    const { best, all } = findGame({ reg: noReg, fs, env: {}, versions: () => ({}), drives: () => ['C:\\', 'D:\\', 'F:\\', 'G:\\'] });
    expect(all.map((g) => g.dir).sort()).toEqual(['C:\\Games\\Cyberpunk 2077', 'D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077', 'G:\\Cyberpunk.2077.GOG.Rip-InsaneRamZes']);
    expect(all.every((g) => g.source === 'disk scan')).toBe(true);
    // no versions known: the newest exe wins
    expect(best.dir).toBe('G:\\Cyberpunk.2077.GOG.Rip-InsaneRamZes');
  });

  it('returns nothing when there is no game', () => {
    const fs = fakeFs({ 'C:\\Games\\Witcher 3\\bin\\witcher3.exe': '' });
    expect(findGame({ reg: noReg, fs, env: {}, versions: () => ({}), drives: () => ['C:\\'] })).toEqual({ best: undefined, all: [] });
  });

  it('scanDirs skips system folders and lists Xbox Content folders', () => {
    const fs = fakeFs({ 'C:\\Windows\\a\\x.txt': '', 'C:\\Games\\b\\x.txt': '', 'C:\\XboxGames\\Cyberpunk 2077\\Content\\x.txt': '' });
    const dirs = scanDirs(['C:\\'], fs);
    expect(dirs).toContain('C:\\Games\\b');
    expect(dirs).toContain('C:\\XboxGames\\Cyberpunk 2077\\Content');
    expect(dirs.some((d) => /windows/i.test(d))).toBe(false);
  });
});
