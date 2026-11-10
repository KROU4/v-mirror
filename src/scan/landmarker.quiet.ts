// Keeps the glog chatter of the MediaPipe wasm out of the console (main thread and worker).
/**
 * Service lines of the MediaPipe wasm ("INFO: …", glog "W1110 …", "Graph successfully started
 * running."): not errors, kept out of the console.
 */
export const isMediapipeChatter = (a: unknown) =>
  typeof a === 'string' && /^(?:INFO: |Graph successfully started running|[IW]\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ \S+\.cc:\d+\])/.test(a);

let quiet = false;
export function quietMediapipe() {
  if (quiet || typeof console === 'undefined') return;
  quiet = true;
  for (const level of ['error', 'warn', 'info', 'log'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (isMediapipeChatter(args[0])) return;
      orig(...args);
    };
  }
}
