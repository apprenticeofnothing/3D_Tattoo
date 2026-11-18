// Puts the pose model and its WebAssembly runtime in public/mediapipe/ so
// the app serves them itself: photos are analysed in the browser and the
// browser never contacts a third party. Runs after `npm install`.
// The model (Apache-2.0, Google MediaPipe) is downloaded once; failures
// are not fatal: the app then falls back to choosing the spot by hand.
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const out = path.join(root, 'public', 'mediapipe');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const MODEL = 'pose_landmarker_full.task';
const MODEL_URL = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/${MODEL}`;

fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  const src = path.join(wasmSrc, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, 'wasm', f));
  else console.warn(`fetch-models: ${src} missing (is @mediapipe/tasks-vision installed?)`);
}
const modelPath = path.join(out, MODEL);
if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1e6) {
  console.log('fetch-models: pose model already present');
} else {
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(modelPath, buf);
    console.log(`fetch-models: downloaded ${MODEL} (${(buf.length / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    console.warn(`fetch-models: could not download the pose model (${err.message}). Placement suggestions from photos will be off; everything else works.`);
  }
}
