// Errors of the face detector with a code: the scan panel shows a translated text for the code,
// and the English message (URL, HTTP status, worker message) stays for the console.

/**
 * timeout — the worker stopped answering; crashed — the worker script failed or died;
 * closed — the detector was freed while a call waited; download — the wasm or the model did
 * not download; notReady — a photo came before the detector started; loader — the wasm loader
 * has no factory.
 */
export type LandmarkerErrorCode = 'timeout' | 'crashed' | 'closed' | 'download' | 'notReady' | 'loader';

export const LANDMARKER_ERROR_CODES: readonly LandmarkerErrorCode[] = ['timeout', 'crashed', 'closed', 'download', 'notReady', 'loader'];

export class LandmarkerError extends Error {
  readonly code: LandmarkerErrorCode;
  constructor(code: LandmarkerErrorCode, message: string) {
    super(message);
    this.name = 'LandmarkerError';
    this.code = code;
  }
}

/** The code of a detector error, also of one rebuilt from a worker reply (name and code only). */
export function landmarkerErrorCode(e: unknown): LandmarkerErrorCode | null {
  if (!e || typeof e !== 'object') return null;
  const code = (e as { code?: unknown }).code;
  return (e as { name?: unknown }).name === 'LandmarkerError' && typeof code === 'string' && (LANDMARKER_ERROR_CODES as readonly string[]).includes(code)
    ? (code as LandmarkerErrorCode)
    : null;
}
