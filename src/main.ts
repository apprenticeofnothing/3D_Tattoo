import './style.css';
import { Mesh, Vector3 } from 'three';
import { fitToHeight } from './body/fit';
import { makePlaceholderBody } from './body/placeholder';
import { locateRegion, type RegionDef } from './body/regions';
import { loadBodyFiles } from './io/loadMesh';
import { createPicker } from './ui/picker';
import { Viewer } from './viewer/Viewer';

const HEIGHT_KEY = 'tattoo.heightCm';
const app = document.getElementById('app')!;
const stage = document.getElementById('stage')!;
const status = document.getElementById('status')!;
const heightInput = document.getElementById('height') as HTMLInputElement;
const fileInput = document.getElementById('file') as HTMLInputElement;

heightInput.value = localStorage.getItem(HEIGHT_KEY) ?? '193';
const heightM = () => Math.max(0.5, Math.min(2.5, (Number(heightInput.value) || 193) / 100));

const viewer = new Viewer(stage);
let bodyPositions: Float32Array = new Float32Array(0);
let bodyLabel = 'Placeholder body';

function setStatus(text: string) { status.textContent = text; }

/** Gather world-space vertex positions of the current body for region lookup. */
function collectPositions(): Float32Array {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (const m of viewer.bodyMeshes()) {
    const pos = (m.geometry.getAttribute('position') as { array: ArrayLike<number>; count: number });
    const out = new Float32Array(pos.count * 3);
    const v = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.array[i * 3], pos.array[i * 3 + 1], pos.array[i * 3 + 2]).applyMatrix4(m.matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    chunks.push(out); total += out.length;
  }
  const all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

function showPlaceholder() {
  setStatus('Building placeholder body…');
  setTimeout(() => {
    const h = heightM();
    const { mesh, triangles } = makePlaceholderBody(h, 0.01);
    viewer.setBody(mesh);
    mesh.updateMatrixWorld(true);
    bodyPositions = collectPositions();
    bodyLabel = 'Placeholder body';
    setStatus(`${bodyLabel} · ${Math.round(h * 100)} cm · ${(triangles / 1000).toFixed(0)}k triangles`);
    viewer.frameBody(h);
  }, 30);
}

async function loadFiles(files: File[]) {
  if (files.length === 0) return;
  setStatus(`Loading ${files.map((f) => f.name).join(', ')}…`);
  try {
    const loaded = await loadBodyFiles(files);
    const h = heightM();
    const { group, info } = fitToHeight(loaded.object, h);
    viewer.setBody(group);
    bodyPositions = collectPositions();
    bodyLabel = files.find((f) => /\.(glb|gltf|obj|ply)$/i.test(f.name))?.name ?? 'Scan';
    const note = info.rotatedToYUp ? ' · rotated to upright' : '';
    setStatus(`${bodyLabel} · ${Math.round(h * 100)} cm · ${(loaded.triangles / 1000).toFixed(0)}k triangles${loaded.textured ? ' · textured' : ''}${note}`);
    viewer.frameBody(h);
  } catch (err) {
    console.error(err);
    setStatus(`Could not load: ${(err as Error).message}`);
  }
}

function goTo(def: RegionDef) {
  const pose = locateRegion(def, bodyPositions, heightM());
  if (!pose) { setStatus(`Could not find ${def.label} on this body`); return; }
  viewer.flyTo(pose);
  setStatus(def.label);
}

const picker = createPicker(app, goTo);
document.getElementById('btn-parts')!.addEventListener('click', picker.open);
document.getElementById('btn-reset')!.addEventListener('click', () => viewer.frameBody(heightM()));
document.getElementById('btn-load')!.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { loadFiles(Array.from(fileInput.files ?? [])); fileInput.value = ''; });
heightInput.addEventListener('change', () => {
  localStorage.setItem(HEIGHT_KEY, String(Math.round(heightM() * 100)));
  heightInput.value = String(Math.round(heightM() * 100));
  const body = viewer.getBody();
  if (body && (body as Mesh).name === 'placeholder-body') showPlaceholder();
  else if (body) {
    // Re-fit the loaded scan to the new height.
    const inner = body.children[0];
    if (inner) { body.remove(inner); const { group } = fitToHeight(inner, heightM()); viewer.setBody(group); bodyPositions = collectPositions(); viewer.frameBody(heightM()); }
  }
});

// Drag and drop on desktop.
stage.addEventListener('dragover', (e) => { e.preventDefault(); });
stage.addEventListener('drop', (e) => { e.preventDefault(); loadFiles(Array.from(e.dataTransfer?.files ?? [])); });

showPlaceholder();
