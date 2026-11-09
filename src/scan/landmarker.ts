// Загрузка MediaPipe Face Landmarker (работает целиком в браузере, бесплатно).
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

let instance: Promise<FaceLandmarker> | null = null;

export function getLandmarker(): Promise<FaceLandmarker> {
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
      try {
        return await create('GPU');
      } catch {
        return await create('CPU');
      }
    })();
    instance.catch(() => (instance = null));
  }
  return instance;
}

export async function detect(source: HTMLCanvasElement | HTMLImageElement | ImageBitmap): Promise<FaceLandmarkerResult> {
  const lm = await getLandmarker();
  return lm.detect(source);
}
