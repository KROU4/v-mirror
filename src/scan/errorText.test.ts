import { describe, expect, it } from 'vitest';
import { LANGS, translate, type MsgKey, type Params } from '../i18n';
import { LANDMARKER_ERROR_CODES, LandmarkerError } from './landmarker.errors';
import { analyzeErrorText, LM_ERR_KEY } from './errorText';

/** Сообщения ошибок как они приходят от воркера и загрузчика: URL, HTTP-статус, английский текст. */
const RAW = 'https://example.org/v-mirror/mediapipe/face_landmarker.task: HTTP 404 Not Found';

describe('analyzeErrorText', () => {
  for (const lang of LANGS) {
    const t = (k: MsgKey, p?: Params) => translate(lang, k, p);

    it(`${lang}: каждый код детектора — свой переведённый текст, без исходного сообщения`, () => {
      const seen = new Set<string>();
      for (const code of LANDMARKER_ERROR_CODES) {
        const s = analyzeErrorText(new LandmarkerError(code, RAW), t);
        expect(s).toBe(t('scan.analyzeFailed', { msg: t(LM_ERR_KEY[code]) }));
        expect(s).not.toContain('http');
        expect(s).not.toContain('404');
        expect(s).not.toMatch(/\{msg\}/);
        seen.add(s);
      }
      expect(seen.size).toBe(LANDMARKER_ERROR_CODES.length);
    });

    it(`${lang}: ошибка с кодом, пересобранная из ответа воркера (только name и code)`, () => {
      expect(analyzeErrorText({ name: 'LandmarkerError', code: 'download', message: RAW }, t)).toBe(t('scan.analyzeFailed', { msg: t('scan.lmErr.download') }));
    });

    it(`${lang}: лица нет — отдельный текст`, () => {
      expect(analyzeErrorText(new Error('NO_FACE'), t)).toBe(t('scan.noFace'));
    });

    it(`${lang}: ошибка без кода (устаревший чанк после редеплоя) — общий текст, не исходное сообщение`, () => {
      const stale = new TypeError('Failed to fetch dynamically imported module: https://example.org/v-mirror/assets/landmarker.core-abc.js');
      for (const e of [stale, new Error(RAW), 'строка', null, undefined]) {
        const s = analyzeErrorText(e, t);
        expect(s).toBe(t('scan.analyzeFailed', { msg: t('scan.lmErr.unknown') }));
        expect(s).not.toContain('http');
        expect(s).not.toContain('dynamically');
      }
    });
  }
});
