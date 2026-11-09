// Вспомогательный «тест» для ручной проверки: печатает описания морфов.
// Запуск: npx vitest run tools/calibrate/print_morphs.test.ts (G=female для тела 2)
import { it } from 'vitest';
import { MORPH_SLOTS, morphInfo } from '../../src/model/descriptors';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const g = env.G === 'female' ? 'female' : 'male';

it(`описания морфов (${g})`, () => {
  for (const slot of MORPH_SLOTS) {
    console.log(slot, morphInfo(g, slot).options.map((o) => `${o.i + 1}: ${o.text.ru}`).join(' | '));
  }
});
