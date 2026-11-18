// MediaPipe Pose Landmarker, run in the browser on a still photo. The model
// and runtime are served by the app itself (public/mediapipe, fetched by
// scripts/fetch-models.mjs), so the photo never leaves the device.
// Loaded lazily the first time a photo is analysed.

import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Rgba } from './image';
import type { Landmark } from './poseSuggest';

export interface PoseDetection {
  /** 33 landmarks, x/y as fractions of the photo's width/height. */
  landmarks: Landmark[];
  /** The same in metres around the hips (x right, y down, z away from the camera). */
  world: Landmark[];
  /** Person probability per pixel, covering the whole photo. */
  mask: { data: Float32Array; width: number; height: number } | null;
}

const BASE = `${import.meta.env.BASE_URL}mediapipe/`;
const MODEL = `${BASE}pose_landmarker_full.task`;
let loading: Promise<PoseLandmarker | null> | null = null;
/** Person masks need the GPU path (the CPU path of this runtime aborts on them). */
let withMasks = true;

async function create(gpu: boolean): Promise<PoseLandmarker | null> {
  const head = await fetch(MODEL, { method: 'HEAD' });
  if (!head.ok) return null;
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks(`${BASE}wasm`);
  return PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL, delegate: gpu ? 'GPU' : 'CPU' },
    runningMode: 'IMAGE',
    numPoses: 1,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    outputSegmentationMasks: gpu,
  });
}

export function poseModel(): Promise<PoseLandmarker | null> {
  loading ??= (async () => {
    try { withMasks = true; return await create(true); } catch (err) { console.warn('Pose model on the GPU failed, using the CPU:', err); }
    try { withMasks = false; return await create(false); } catch (err) { console.warn('Pose model unavailable:', err); return null; }
  })();
  return loading;
}

/** Find the person in a photo; null when there is no model or nobody is found. */
export async function detectPose(photo: Rgba): Promise<PoseDetection | null> {
  let model = await poseModel();
  if (!model) return null;
  // The model works on a small input anyway; a moderate size keeps the mask useful and the call quick.
  const s = Math.min(1, 1024 / Math.max(photo.width, photo.height));
  const src = document.createElement('canvas');
  src.width = photo.width; src.height = photo.height;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(photo.data), photo.width, photo.height), 0, 0);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(photo.width * s)); c.height = Math.max(1, Math.round(photo.height * s));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  let res;
  try { res = model.detect(c); } catch (err) {
    if (!withMasks) throw err;
    // GPU path failed at run time: start again on the CPU, without masks.
    console.warn('Pose detection on the GPU failed, retrying on the CPU:', err);
    withMasks = false;
    loading = create(false).catch(() => null);
    model = await loading;
    if (!model) return null;
    res = model.detect(c);
  }
  try {
    if (!res.landmarks?.length) return null;
    const m = res.segmentationMasks?.[0];
    const mask = m ? { data: new Float32Array(m.getAsFloat32Array()), width: m.width, height: m.height } : null;
    return {
      landmarks: res.landmarks[0].map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility })),
      world: (res.worldLandmarks?.[0] ?? []).map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility })),
      mask,
    };
  } finally {
    res.segmentationMasks?.forEach((m) => m.close());
  }
}
