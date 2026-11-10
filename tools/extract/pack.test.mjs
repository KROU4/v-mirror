import { describe, expect, it } from 'vitest';
import { defaultOutDir, lackingFiles, packCompleteness, recipeId, toolName } from './pack.mjs';

describe('pack: default pack folder', () => {
  const env = { USERPROFILE: 'C:\\Users\\V', LOCALAPPDATA: 'C:\\Users\\V\\AppData\\Local' };
  const win = (o) => defaultOutDir({ env, platform: 'win32', home: 'C:\\Users\\V', ...o });

  it('is Documents\\V-Mirror pack when the Documents folder is there', () => {
    expect(win({ exists: () => true, realpath: (p) => p })).toBe('C:\\Users\\V\\Documents\\V-Mirror pack');
  });

  it('is %LOCALAPPDATA%\\v-mirror\\pack without a Documents folder', () => {
    expect(win({ exists: () => false, realpath: () => { throw new Error('ENOENT'); } })).toBe('C:\\Users\\V\\AppData\\Local\\v-mirror\\pack');
    // no LOCALAPPDATA either: the usual place under the profile
    expect(defaultOutDir({ env: { USERPROFILE: 'C:\\Users\\V' }, platform: 'win32', exists: () => false, realpath: (p) => p })).toBe('C:\\Users\\V\\AppData\\Local\\v-mirror\\pack');
  });

  it('avoids a Documents folder synced by OneDrive (the pack is ~600 MB of game files)', () => {
    expect(win({ exists: () => true, realpath: () => 'C:\\Users\\V\\OneDrive\\Documents' })).toBe('C:\\Users\\V\\AppData\\Local\\v-mirror\\pack');
  });

  it('outside Windows: ~/Documents or the XDG data folder', () => {
    expect(defaultOutDir({ env: { HOME: '/home/v' }, platform: 'linux', home: '/home/v', exists: () => true, realpath: (p) => p })).toBe('/home/v/Documents/V-Mirror pack');
    expect(defaultOutDir({ env: {}, platform: 'linux', home: '/home/v', exists: () => false, realpath: (p) => p })).toBe('/home/v/.local/share/v-mirror/pack');
  });
});

describe('pack: is the existing pack complete?', () => {
  const tool = 'v-mirror 0.1.0';
  const recipe = 'abc123';
  const expect_ = ['body/manifest.json', 'tex/skin/a.png', 'glb/head.glb'];
  const files = ['body/manifest.json', 'tex/skin/a.webp', 'glb/head.glb', 'hair/extra.json'];
  const manifest = { format: 1, gameVersion: '2.5', tool: 'v-mirror 0.1.0 (WolvenKit 9.1.1)', recipe };
  const check = (m, f = files, gameVersion = '2.5') => packCompleteness(m, f, { tool, recipe, expect: expect_, gameVersion });

  it('lists expected files that are missing (.png may have become .webp)', () => {
    expect(lackingFiles(files, expect_)).toEqual([]);
    expect(lackingFiles(['body/manifest.json'], expect_)).toEqual(['tex/skin/a.png', 'glb/head.glb']);
  });

  it('accepts a pack of the same tool version, recipe and game version', () => {
    expect(check(manifest)).toEqual({ complete: true });
    // game version unknown on either side: not a reason to rebuild
    expect(check(manifest, files, undefined).complete).toBe(true);
    expect(check({ ...manifest, gameVersion: 'unknown' }).complete).toBe(true);
  });

  it('rebuilds another version, recipe, game version or an incomplete pack', () => {
    expect(check(null)).toMatchObject({ complete: false });
    expect(check({ ...manifest, format: 2 })).toMatchObject({ complete: false });
    expect(check({ ...manifest, tool: 'v-mirror 0.0.9 (WolvenKit 9.1.1)' }).reason).toMatch(/built by v-mirror 0\.0\.9/);
    expect(check({ ...manifest, tool: 'v-mirror 0.1.01' }).complete).toBe(false);
    expect(check({ ...manifest, recipe: undefined }).reason).toMatch(/recipe/);
    expect(check(manifest, files, '2.31').reason).toMatch(/game is now 2\.31/);
    expect(check(manifest, ['body/manifest.json']).reason).toMatch(/2 files are missing/);
  });

  it('names this tool and a stable recipe id', () => {
    expect(toolName()).toMatch(/^v-mirror \d+\.\d+\.\d+/);
    expect(recipeId()).toMatch(/^[0-9a-f]{16}$/);
    expect(recipeId()).toBe(recipeId());
  });
});
