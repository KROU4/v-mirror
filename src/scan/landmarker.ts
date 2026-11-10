// Загрузка MediaPipe Face Landmarker (работает целиком в браузере, бесплатно).
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

let instance: Promise<FaceLandmarker> | null = null;

/** Служебные строки glog из wasm MediaPipe («INFO: …», «W1110 …») — не ошибки, в консоль их не пускаем. */
export const isMediapipeChatter = (a: unknown) => typeof a === 'string' && /^(?:INFO: |[IW]\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ \S+\.cc:\d+\])/.test(a);
let quiet = false;
function quietMediapipe() {
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

export function getLandmarker(): Promise<FaceLandmarker> {
  quietMediapipe();
  if (!instance) {
    const base = import.meta.env.BASE_URL;
    instance = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
      const create = (delegate: 'GPU' | 'CPU') =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}mediapipe/face_landmarker.task`, delegate },
          runningMode: 'IMAGE',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      let lm: FaceLandmarker;
      try {
        lm = await create('GPU');
      } catch {
        lm = await create('CPU');
      }
      // Граф на видеокарте собирается при первом detect() — по выбранному фото, под индикатором
      // «Ищу лицо». Прогрев на пустом кадре при открытии скана занимал главный поток на ~2 с,
      // пока человек ещё выбирал фото (кнопки панели не отвечали)
      return lm;
    })();
    instance.catch(() => (instance = null));
  }
  return instance;
}

export async function detect(source: HTMLCanvasElement | HTMLImageElement | ImageBitmap): Promise<FaceLandmarkerResult> {
  const lm = await getLandmarker();
  return lm.detect(source);
}
