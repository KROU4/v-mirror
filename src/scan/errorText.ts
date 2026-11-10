// Тексты ошибок анализа фото на языке интерфейса (вынесены из ScanPanel ради тестов).
import { landmarkerErrorCode, type LandmarkerErrorCode } from './landmarker.errors';
import type { MsgKey, T } from '../i18n';

export const LM_ERR_KEY: Record<LandmarkerErrorCode, MsgKey> = {
  timeout: 'scan.lmErr.timeout',
  crashed: 'scan.lmErr.crashed',
  closed: 'scan.lmErr.closed',
  download: 'scan.lmErr.download',
  notReady: 'scan.lmErr.notReady',
  loader: 'scan.lmErr.loader',
};

/**
 * Текст ошибки анализа фото на языке интерфейса: по коду ошибки детектора, иначе общий.
 * Исходное английское сообщение (URL, HTTP-статус, текст воркера) — только в консоль.
 * Ошибка без кода (TypeError от import() устаревшего чанка после редеплоя) — общий текст.
 */
export function analyzeErrorText(e: unknown, t: T): string {
  if ((e as Error)?.message === 'NO_FACE') return t('scan.noFace');
  const code = landmarkerErrorCode(e);
  return t('scan.analyzeFailed', { msg: t(code ? LM_ERR_KEY[code] : 'scan.lmErr.unknown') });
}
