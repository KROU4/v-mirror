// Насколько признаки различают варианты морфов: node tools/calibrate/feature_spread.mjs male
import fs from 'node:fs';
const g = process.argv[2] ?? 'male';
const m = JSON.parse(fs.readFileSync(`src/data/morphs.${g}.json`, 'utf8'));
const SLOT_FEATURES = {
  eyes: ['eyeWidth', 'eyeOpen', 'eyeTilt', 'eyeSpacing'],
  nose: ['noseWidth', 'noseLength', 'noseBridge'],
  mouth: ['mouthWidth', 'upperLip', 'lowerLip'],
  jaw: ['jawWidth', 'chinWidth', 'lowerFace', 'chinLength', 'faceLength'],
};
for (const [slot, feats] of Object.entries(SLOT_FEATURES)) {
  const rows = m.slots[slot];
  console.log(`== ${slot}`);
  for (const f of feats) {
    const vals = rows.map((r) => r.features[f]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    console.log(`  ${f.padEnd(11)} base=${m.base[f].toFixed(3)} min=${Math.min(...vals).toFixed(3)} max=${Math.max(...vals).toFixed(3)} sd=${sd.toFixed(4)} cv=${((sd / Math.abs(mean)) * 100).toFixed(1)}%`);
  }
  // контроль: меняют ли морфы других слотов эти признаки (шум детектора)
  const others = Object.keys(SLOT_FEATURES).filter((s) => s !== slot);
  const noise = feats.map((f) => {
    const vals = others.flatMap((s) => m.slots[s].map((r) => r.features[f]));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length).toFixed(4);
  });
  console.log(`  шум от других морфов (sd): ${noise.join(' ')}`);
}
