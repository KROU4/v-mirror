// Частота кадров и плотность пикселей холста: на слабой видеокарте движок сам снижает
// devicePixelRatio, на сильной возвращает его. Без three.js.

/** Пределы и пороги подстройки. */
export const DPR = {
  /** выше 2 разницы на глаз нет, а пикселей вчетверо больше */
  max: 2,
  min: 0.75,
  step: 0.25,
  /** средний кадр дольше — снижаем плотность (меньше ~45 к/с) */
  slowMs: 22,
  /** короче — можно поднять (кадр укладывается в 60 Гц) */
  fastMs: 17.5,
  /** окно усреднения, кадров */
  window: 90,
};

/** Начальная плотность: экран устройства, но не больше DPR.max. */
export function initialPixelRatio(deviceRatio: number | undefined): number {
  return Math.min(Math.max(deviceRatio || 1, 1), DPR.max);
}

/**
 * Следующая плотность по среднему времени кадра: шаг вниз, если кадр медленный, шаг вверх,
 * если быстрый, иначе та же. Вверх — не выше устройства и не выше ceiling: плотности, на
 * которой кадр уже был медленным, движок больше не пробует (иначе качели вверх-вниз).
 */
export function nextPixelRatio(current: number, avgMs: number, deviceRatio: number, ceiling = Infinity): number {
  const cap = Math.min(initialPixelRatio(deviceRatio), ceiling);
  if (avgMs > DPR.slowMs && current > DPR.min) return Math.max(DPR.min, current - DPR.step);
  if (avgMs < DPR.fastMs && current < cap) return Math.min(cap, current + DPR.step);
  return current;
}

/**
 * Сколько недавно снятых вариантов держать в памяти: переключение туда-обратно не грузит
 * их заново, а всё, что старше, освобождается (геометрия, материалы, текстуры).
 */
export const KEEP_RECENT = { hair: 2, beard: 3, intimateMeshes: 4, intimateMaterials: 6 };

/**
 * Список «недавно использованных» (последний — самый свежий): поднять used наверх и вернуть
 * то, что вытеснено — не используется сейчас и старше keep последних снятых.
 */
export function touchRecent(order: string[], used: string[], keep: number): { order: string[]; evict: string[] } {
  const now = new Set(used);
  const rest = order.filter((k) => !now.has(k));
  const kept = rest.slice(Math.max(0, rest.length - keep));
  return { order: [...kept, ...used.filter((k, i) => used.indexOf(k) === i)], evict: rest.slice(0, rest.length - kept.length) };
}

/** Скользящая статистика кадров. */
export class FrameStats {
  private times: number[] = [];
  private sum = 0;
  frames = 0;

  push(ms: number) {
    this.frames++;
    this.times.push(ms);
    this.sum += ms;
    if (this.times.length > DPR.window) this.sum -= this.times.shift()!;
  }

  get full() {
    return this.times.length >= DPR.window;
  }

  get avgMs() {
    return this.times.length ? this.sum / this.times.length : 0;
  }

  /** Медиана: одиночные долгие кадры (загрузка текстур, сборка шейдера) её не сдвигают. */
  get medianMs() {
    if (!this.times.length) return 0;
    const s = [...this.times].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  get fps() {
    const a = this.avgMs;
    return a > 0 ? 1000 / a : 0;
  }

  reset() {
    this.times = [];
    this.sum = 0;
  }
}
