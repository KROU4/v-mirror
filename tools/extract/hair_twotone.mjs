// Two-tone hairstyle × colour pairs: in the game some colours dye only part of a hairstyle
// (ends, streaks, the top): the hair-card chunks of that mesh appearance use different hair
// profiles (e.g. 115_alanah + Red Merlot = Brown Liquorice lengths with Merlot ends).
// Reads the local asset pack (tools/local/tex/hair/manifest.json) and writes
// src/data/hair.twotone.json — names only, no game files.
//   node tools/extract/hair_twotone.mjs [packDir]
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const pack = path.resolve(process.argv[2] ?? path.join(root, 'tools', 'local'));
const hm = JSON.parse(fs.readFileSync(path.join(pack, 'tex', 'hair', 'manifest.json'), 'utf8'));

/** Base hair profile of a card material key (cards.<set>.<profile>[#variant]); null for chrome or default. */
const profileOf = (key) => {
  if (!key || !key.startsWith('cards.')) return null;
  const p = key.split('.')[2]?.split('#')[0];
  return !p || p === 'default' || p.startsWith('custom') ? null : p;
};

const out = { _source: 'tools/extract/hair_twotone.mjs: hairstyle (meshHint) -> colour apps whose hair cards mix hair profiles in the game mesh appearance' };
for (const gender of ['female', 'male']) {
  const g = {};
  for (const [hint, h] of Object.entries(hm.hints[gender] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const list = [];
    for (const [colour, map] of Object.entries(h.colours ?? {})) {
      const profiles = new Set();
      for (const [stem, app] of Object.entries(map)) for (const k of hm.meshes[stem]?.appearances?.[app] ?? []) profiles.add(profileOf(k));
      profiles.delete(null);
      if (profiles.size > 1) list.push(colour);
    }
    if (list.length) g[hint] = list.sort();
  }
  out[gender] = g;
}
const dst = path.join(root, 'src', 'data', 'hair.twotone.json');
fs.writeFileSync(dst, JSON.stringify(out, null, 1) + '\n');
console.log('wrote', path.relative(root, dst), Object.keys(out.female).length, 'female /', Object.keys(out.male).length, 'male hairstyles');
