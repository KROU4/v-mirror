// Краткая сводка каталога: node tools/extract/print_catalog.mjs src/data/catalog.male.json
import fs from 'node:fs';
const cat = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const s of cat.slots) {
  const counts = [...new Set(s.variants.map((v) => v.options.length))].join('/');
  const ex = s.variants[0].options.slice(0, 3).map((o) => `${o.label.ru}${o.hex ? ' ' + o.hex : ''}${o.meshHint ? ' <' + o.meshHint + '>' : ''}`).join(' | ');
  console.log(`${s.group.padEnd(4)} ${String(s.order).padStart(4)} ${s.id.padEnd(26)} «${s.label.ru}» var=${s.variants.length} opts=${counts} :: ${ex}`);
}
console.log(cat.stats);
