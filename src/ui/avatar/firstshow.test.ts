import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_PARTS_WAIT_MS, FirstShowGate } from './firstshow';

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

/** Отметка, что промис разрешился (без ожидания). */
function track(p: Promise<unknown>) {
  const s = { done: false };
  void p.then(() => (s.done = true));
  return s;
}

describe('FirstShowGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const gate = () => new FirstShowGate<string>(() => Date.now());

  it('ждёт части первого показа, но не дольше лимита', async () => {
    const g = gate();
    g.open('m');
    const hair = deferred();
    const w = track(g.wait('m', [hair.p]));
    await vi.advanceTimersByTimeAsync(FIRST_PARTS_WAIT_MS - 1);
    expect(w.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.done).toBe(true);
  });

  it('разрешается, как только части готовы (в том числе с ошибкой)', async () => {
    const g = gate();
    g.open('m');
    const hair = deferred();
    const w = track(g.wait('m', [hair.p, Promise.reject(new Error('нет бород'))]));
    await vi.advanceTimersByTimeAsync(100);
    expect(w.done).toBe(false);
    hair.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.done).toBe(true);
  });

  it('вытеснение во время ожидания: повторный вызов для того же тела тоже ждёт свои части', async () => {
    // setLook#1 открыл ожидание и ждёт; loadExtras надевает вид ещё раз (setLook#2): у него
    // тело уже «активно», но ещё не показано — onShown не должен прийти раньше причёски
    const g = gate();
    g.open('m');
    const hair1 = deferred();
    void g.wait('m', [hair1.p]);
    await vi.advanceTimersByTimeAsync(900);
    hair1.resolve(); // причёска первого вызова отменена токеном и вернулась пустой
    const hair2 = deferred();
    const w2 = track(g.wait('m', [hair2.p]));
    await vi.advanceTimersByTimeAsync(500);
    expect(w2.done).toBe(false);
    hair2.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(w2.done).toBe(true);
  });

  it('вытеснивший вызов ждёт только остаток общего срока', async () => {
    const g = gate();
    g.open('m');
    void g.wait('m', [new Promise(() => {})]);
    await vi.advanceTimersByTimeAsync(2000);
    const w2 = track(g.wait('m', [new Promise(() => {})]));
    await vi.advanceTimersByTimeAsync(FIRST_PARTS_WAIT_MS - 2000 - 1);
    expect(w2.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w2.done).toBe(true);
    // срок вышел — дальше без ожидания
    const w3 = track(g.wait('m', [new Promise(() => {})]));
    await vi.advanceTimersByTimeAsync(0);
    expect(w3.done).toBe(true);
  });

  it('после показа (close) и для другого тела не ждёт', async () => {
    const g = gate();
    g.open('m');
    expect(g.pending('f')).toBe(false);
    const other = track(g.wait('f', [new Promise(() => {})]));
    g.close('f'); // чужое тело ожидание не закрывает
    expect(g.pending('m')).toBe(true);
    g.close('m');
    const after = track(g.wait('m', [new Promise(() => {})]));
    await vi.advanceTimersByTimeAsync(0);
    expect(other.done).toBe(true);
    expect(after.done).toBe(true);
  });

  it('новое переключение на тело открывает ожидание заново', async () => {
    const g = gate();
    g.open('f');
    await vi.advanceTimersByTimeAsync(FIRST_PARTS_WAIT_MS + 10);
    expect(g.pending('f')).toBe(false);
    g.open('f');
    expect(g.pending('f')).toBe(true);
  });
});
