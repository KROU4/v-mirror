// Ожидание причёски, бороды и слоёв при первом показе тела. Хранится на движке, а не в
// вызове setLook: вызов, открывший ожидание, может быть вытеснен (повторное надевание после
// догрузки зубов и ногтей, смена вида), и тогда ждать должен тот, кто дойдёт до конца.

/**
 * Первый показ тела (холодная загрузка, смена типа тела): тело встаёт на сцену, когда готовы
 * причёска, борода и слои, но не позже этого срока. Без ожидания V 0,4–0,8 с стояла лысой
 * после снятия заставки, а причёска появлялась рывком. Медленная причёска (сеть) не держит
 * показ дольше лимита.
 */
export const FIRST_PARTS_WAIT_MS = 3000;

export class FirstShowGate<K> {
  private key: K | null = null;
  private until = 0;

  constructor(
    private now: () => number = () => performance.now(),
    private limitMs = FIRST_PARTS_WAIT_MS,
  ) {}

  /** Тело key ещё не показано (на него только что переключились): ожидание до now + limitMs. */
  open(key: K) {
    this.key = key;
    this.until = this.now() + this.limitMs;
  }

  /** Ожидание открыто для key и срок не вышел. */
  pending(key: K): boolean {
    return this.key === key && this.now() < this.until;
  }

  /**
   * Ждёт части этого вызова (allSettled), но не дольше остатка общего срока. Для другого тела
   * или после close — сразу. Вытеснивший вызов ждёт свои части: старые к этому времени
   * отменены токенами движка, а новые несут последний вид.
   */
  async wait(key: K, parts: Promise<unknown>[]): Promise<void> {
    if (!this.pending(key)) return;
    const left = this.until - this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(parts), new Promise<void>((r) => (timer = setTimeout(r, left)))]);
    clearTimeout(timer);
  }

  /** Тело показано: дальше части догружаются без ожидания. */
  close(key: K) {
    if (this.key === key) this.key = null;
  }
}
