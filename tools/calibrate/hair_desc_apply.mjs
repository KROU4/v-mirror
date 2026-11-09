// Переносит описания причёсок «номер в редакторе -> текст» в src/data/hair.<g>.json,
// где ключ — meshHint (меш причёски). Номер — позиция варианта в редакторе (1-based).
//   node tools/calibrate/hair_desc_apply.mjs male путь/к/описаниям.json
// Формат входа: { "1": ["рус", "eng"], ... }
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [g, src] = process.argv.slice(2);
const cat = JSON.parse(readFileSync(path.join(root, `src/data/catalog.${g}.json`), 'utf8'));
const opts = cat.slots.find((s) => s.id === 'hairstyle').variants[0].options;
const byNum = JSON.parse(readFileSync(src, 'utf8'));
const outPath = path.join(root, `src/data/hair.${g}.json`);
const out = JSON.parse(readFileSync(outPath, 'utf8'));

let n = 0;
for (const [num, [ru, en]] of Object.entries(byNum)) {
  const o = opts[Number(num) - 1];
  if (!o) throw new Error(`нет варианта ${num}`);
  const key = Array.isArray(o.meshHint) ? o.meshHint[0] : o.meshHint;
  if (!key || key === 'none') continue;
  if (out[key] && out[key].ru !== ru) console.warn(`ключ ${key} (вариант ${num}) уже описан иначе: «${out[key].ru}» -> «${ru}»`);
  out[key] = { ru, en };
  n++;
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(outPath, JSON.stringify(sorted, null, 1) + '\n');
console.log(`${g}: записано ${n}, всего ключей ${Object.keys(sorted).length}`);
