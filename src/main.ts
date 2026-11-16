import './style.css';
import { Mesh, Raycaster, Vector2 } from 'three';
import { fitToHeight } from './body/fit';
import { makePlaceholderBody } from './body/placeholder';
import { locateRegion, type RegionDef } from './body/regions';
import { loadBodyFiles } from './io/loadMesh';
import { createPicker } from './ui/picker';
import { Viewer } from './viewer/Viewer';
import { surfaceFromObject, triangleForHit, type SurfaceMesh } from './mesh/topology';
import { loadDesignFile, rasterizeSvg, type DesignImage } from './design/raster';
import { TEST_PATTERN_WIDTH_CM, testPatternSvg } from './design/testPattern';
import { PlacedDesign, type Placement } from './mapping/placements';
import type { DecalMode } from './mapping/decal';

const HEIGHT_KEY = 'tattoo.heightCm';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app'), stage = $('stage'), status = $('status'), hint = $('hint'), panel = $('panel');
const heightInput = $<HTMLInputElement>('height');
const fileInput = $<HTMLInputElement>('file');
const designInput = $<HTMLInputElement>('design-file');

heightInput.value = localStorage.getItem(HEIGHT_KEY) ?? '193';
const heightM = () => Math.max(0.5, Math.min(2.5, (Number(heightInput.value) || 193) / 100));

const viewer = new Viewer(stage);
let surface: SurfaceMesh | null = null;
let bodyLabel = 'Placeholder body';
let bodyInfo = '';
const placed: PlacedDesign[] = [];
let selected: PlacedDesign | null = null;
let pendingDesign: DesignImage | null = null; // waiting for a tap
let moving: PlacedDesign | null = null; // re-anchoring an existing design
let testDesign: DesignImage | null = null;

function setStatus(text: string) { status.textContent = text; }
function bodyStatus() { setStatus(`${bodyLabel} · ${Math.round(heightM() * 100)} cm${bodyInfo}`); }

function afterBodyChange() {
  const body = viewer.getBody()!;
  const t0 = performance.now();
  surface = surfaceFromObject(body);
  console.log(`surface: ${surface.positions.length / 3} verts, ${surface.indices.length / 3} tris in ${(performance.now() - t0).toFixed(0)} ms`);
  // Existing designs no longer match this body.
  for (const d of placed) { viewer.scene.remove(d.decal.mesh); d.dispose(); }
  placed.length = 0; selected = null; moving = null;
  showPanel(null);
  viewer.frameBody(heightM());
}

function showPlaceholder() {
  setStatus('Building placeholder body…');
  setTimeout(() => {
    const h = heightM();
    const { mesh, triangles } = makePlaceholderBody(h, 0.01);
    viewer.setBody(mesh);
    mesh.updateMatrixWorld(true);
    bodyLabel = 'Placeholder body';
    bodyInfo = ` · ${(triangles / 1000).toFixed(0)}k triangles`;
    afterBodyChange();
    bodyStatus();
  }, 30);
}

async function loadFiles(files: File[]) {
  if (files.length === 0) return;
  setStatus(`Loading ${files.map((f) => f.name).join(', ')}…`);
  try {
    const loaded = await loadBodyFiles(files);
    const { group, info } = fitToHeight(loaded.object, heightM());
    viewer.setBody(group);
    bodyLabel = files.find((f) => /\.(glb|gltf|obj|ply)$/i.test(f.name))?.name ?? 'Scan';
    bodyInfo = ` · ${(loaded.triangles / 1000).toFixed(0)}k triangles${loaded.textured ? ' · textured' : ''}${info.rotatedToYUp ? ' · rotated to upright' : ''}`;
    afterBodyChange();
    bodyStatus();
  } catch (err) {
    console.error(err);
    setStatus(`Could not load: ${(err as Error).message}`);
  }
}

function goTo(def: RegionDef) {
  if (!surface) return;
  const pose = locateRegion(def, surface.positions, heightM());
  if (!pose) { setStatus(`Could not find ${def.label} on this body`); return; }
  viewer.flyTo(pose);
  setStatus(def.label);
}

// ---------- Designs ----------

async function getTestDesign(): Promise<DesignImage> {
  if (!testDesign) testDesign = await rasterizeSvg(testPatternSvg(), 'test-pattern.svg');
  return testDesign;
}

function startPlacing(design: DesignImage) {
  pendingDesign = design; moving = null;
  hint.textContent = `Tap the body where the centre of "${design.name}" should go`;
  hint.classList.remove('hidden');
}

function startMoving(d: PlacedDesign) {
  moving = d; pendingDesign = null;
  hint.textContent = 'Tap the new centre point';
  hint.classList.remove('hidden');
}

const raycaster = new Raycaster();
function pickSurface(clientX: number, clientY: number): { tri: number; point: [number, number, number] } | null {
  if (!surface) return null;
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, viewer.camera);
  const hits = raycaster.intersectObjects(viewer.bodyMeshes(), false);
  const hit = hits.find((h) => h.faceIndex !== undefined && h.faceIndex !== null);
  if (!hit) return null;
  return { tri: triangleForHit(surface, hit.object as Mesh, hit.faceIndex!), point: [hit.point.x, hit.point.y, hit.point.z] };
}

function placeAt(clientX: number, clientY: number): boolean {
  const hit = pickSurface(clientX, clientY);
  if (!hit) { setStatus('That tap missed the body. Try again.'); return false; }
  hint.classList.add('hidden');
  if (moving) {
    moving.placement.tri = hit.tri; moving.placement.point = hit.point;
    const d = moving; moving = null;
    recompute(d);
    return true;
  }
  if (!pendingDesign) return false;
  const design = pendingDesign; pendingDesign = null;
  const widthCm = design.declaredWidthCm ?? (design === testDesign ? TEST_PATTERN_WIDTH_CM : 10);
  const placement: Placement = { id: `d${Date.now()}`, design, tri: hit.tri, point: hit.point, rotation: 0, widthCm, mirror: false, wrap: false, opacity: 1 };
  const pd = new PlacedDesign(placement);
  placed.push(pd);
  viewer.scene.add(pd.decal.mesh);
  select(pd);
  recompute(pd);
  return true;
}

let busy = false, again = false;
function recompute(d: PlacedDesign) {
  if (!surface) return;
  if (busy) { again = true; return; }
  busy = true;
  requestAnimationFrame(() => {
    try {
      const r = d.update(surface!);
      d.setMode(d.mode);
      viewer.requestRender();
      if (d === selected) renderReadout(d);
      console.log(`placement computed in ${r.computeMs.toFixed(0)} ms, ${r.patch.tris.length} tris`);
    } catch (err) {
      console.error(err);
      setStatus(`Mapping failed: ${(err as Error).message}`);
    } finally {
      busy = false;
      if (again) { again = false; recompute(d); }
    }
  });
}

function removeSelected() {
  if (!selected) return;
  const d = selected;
  viewer.scene.remove(d.decal.mesh); d.dispose();
  placed.splice(placed.indexOf(d), 1);
  select(placed[placed.length - 1] ?? null);
  viewer.requestRender();
}

// ---------- Panel ----------
const pWidth = $<HTMLInputElement>('p-width'), pHeight = $('p-height'), pRot = $<HTMLInputElement>('p-rot'), pRotVal = $('p-rot-val');
const pMirror = $<HTMLButtonElement>('p-mirror'), pWrap = $<HTMLButtonElement>('p-wrap'), pOpacity = $<HTMLInputElement>('p-opacity');
const pReadout = $('p-readout');

function select(d: PlacedDesign | null) {
  selected = d;
  showPanel(d);
}

function showPanel(d: PlacedDesign | null) {
  if (!d) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const p = d.placement;
  $('p-name').textContent = p.design.name;
  pWidth.value = String(p.widthCm);
  pRot.value = String(Math.round((p.rotation * 180) / Math.PI));
  pRotVal.textContent = `${pRot.value}°`;
  pMirror.classList.toggle('active', p.mirror);
  pWrap.classList.toggle('active', p.wrap);
  pOpacity.value = String(p.opacity);
  panel.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === d.mode));
  renderReadout(d);
}

function renderReadout(d: PlacedDesign) {
  const r = d.result;
  const p = d.placement;
  if (!r) { pReadout.textContent = 'Computing…'; return; }
  pHeight.textContent = `× ${r.heightCm.toFixed(1)} cm`;
  const s = r.summary;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const worst = Math.max(s.worstStretch, -s.worstCompression);
  const cls = worst > 0.05 ? 'warn' : 'ok';
  const parts = [
    `<b>${p.design.name}</b> ${p.widthCm} × ${r.heightCm.toFixed(1)} cm on the skin`,
    `<span class="${cls}">Stretch up to ${pct(s.worstStretch)}, compression up to ${pct(-s.worstCompression)}; ${pct(s.areaOverThreshold)} of the design beyond 5%</span>`,
  ];
  if (worst > 0.05) parts.push(`<span class="warn">A paper stencil would ${s.worstCompression < -0.05 ? 'wrinkle' : 'tear'} there. Consider a smaller design or a flatter spot.</span>`);
  if (r.circumferenceM !== null) parts.push(`Circumference here: <b>${(r.circumferenceM * 100).toFixed(1)} cm</b> (set width to this, or a fraction of it, for a seamless band)`);
  if (d.mode === 'heatmap') parts.push(`<span class="legend"><i style="background:#1a59f2"></i> compression (wrinkle) <i style="background:#ededed"></i> under 2% <i style="background:#d9261a"></i> stretch (tear); strong colour above 5%</span>`);
  parts.push(`<span class="muted">${r.patch.tris.length} triangles, ${(r.patch.exactCoverage * 100).toFixed(0)}% exact, ${r.computeMs.toFixed(0)} ms</span>`);
  pReadout.innerHTML = parts.join('<br>');
  $('p-summary').innerHTML = `${p.widthCm} × ${r.heightCm.toFixed(1)} cm · <span class="${cls}">max ${pct(worst)}</span>`;
}

// On a phone the panel starts folded so the body stays visible.
if (window.innerWidth < 700) { panel.classList.add('collapsed'); $('p-collapse').textContent = 'Show'; }

pWidth.addEventListener('change', () => { if (!selected) return; selected.placement.widthCm = Math.max(1, Number(pWidth.value) || 10); recompute(selected); });
pRot.addEventListener('input', () => { if (!selected) return; pRotVal.textContent = `${pRot.value}°`; selected.placement.rotation = (Number(pRot.value) * Math.PI) / 180; recompute(selected); });
pMirror.addEventListener('click', () => { if (!selected) return; selected.placement.mirror = !selected.placement.mirror; pMirror.classList.toggle('active', selected.placement.mirror); recompute(selected); });
pWrap.addEventListener('click', () => { if (!selected) return; selected.placement.wrap = !selected.placement.wrap; pWrap.classList.toggle('active', selected.placement.wrap); recompute(selected); });
pOpacity.addEventListener('input', () => { if (!selected) return; selected.placement.opacity = Number(pOpacity.value); selected.decal.setOpacity(selected.placement.opacity); viewer.requestRender(); });
panel.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  if (!selected) return;
  selected.setMode(b.dataset.mode as DecalMode);
  panel.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  renderReadout(selected); viewer.requestRender();
}));
$('p-move').addEventListener('click', () => { if (selected) startMoving(selected); });
$('p-collapse').addEventListener('click', () => { const c = panel.classList.toggle('collapsed'); $('p-collapse').textContent = c ? 'Show' : 'Hide'; });
$('p-remove').addEventListener('click', removeSelected);

// ---------- Tap detection on the canvas ----------
let down: { x: number; y: number; t: number; id: number } | null = null;
const canvas = viewer.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => { if (e.isPrimary) down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || e.pointerId !== down.id) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const dt = performance.now() - down.t;
  down = null;
  if (moved < 8 && dt < 600 && (pendingDesign || moving)) placeAt(e.clientX, e.clientY);
});
canvas.addEventListener('pointercancel', () => { down = null; });

// ---------- Toolbar ----------
const picker = createPicker(app, goTo);
$('btn-parts').addEventListener('click', picker.open);
$('btn-reset').addEventListener('click', () => viewer.frameBody(heightM()));
$('btn-load').addEventListener('click', () => fileInput.click());
$('btn-design').addEventListener('click', () => designInput.click());
$('btn-test').addEventListener('click', async () => startPlacing(await getTestDesign()));
fileInput.addEventListener('change', () => { loadFiles(Array.from(fileInput.files ?? [])); fileInput.value = ''; });
designInput.addEventListener('change', async () => {
  const f = designInput.files?.[0]; designInput.value = '';
  if (!f) return;
  try { startPlacing(await loadDesignFile(f)); } catch (err) { setStatus(`Could not read design: ${(err as Error).message}`); }
});
heightInput.addEventListener('change', () => {
  localStorage.setItem(HEIGHT_KEY, String(Math.round(heightM() * 100)));
  heightInput.value = String(Math.round(heightM() * 100));
  const body = viewer.getBody();
  if (body && (body as Mesh).name === 'placeholder-body') showPlaceholder();
  else if (body) {
    const inner = body.children[0];
    if (inner) { body.remove(inner); const { group } = fitToHeight(inner, heightM()); viewer.setBody(group); afterBodyChange(); bodyStatus(); }
  }
});
stage.addEventListener('dragover', (e) => { e.preventDefault(); });
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  const design = files.find((f) => /\.(svg|png|jpe?g|webp)$/i.test(f.name));
  if (design && files.length === 1) loadDesignFile(design).then(startPlacing).catch((err) => setStatus(`Could not read design: ${(err as Error).message}`));
  else loadFiles(files);
});

// Small hook for automated checks.
(window as unknown as { __app: unknown }).__app = {
  placeTestAt: async (x: number, y: number) => { startPlacing(await getTestDesign()); return placeAt(x, y); },
  selected: () => selected,
  set: (fn: (d: PlacedDesign) => void) => { if (selected) { fn(selected); showPanel(selected); recompute(selected); } },
  goTo: (id: string) => { const def = (window as unknown as { __regions: RegionDef[] }).__regions?.find((r) => r.id === id); if (def) goTo(def); },
  busy: () => busy,
};
import('./body/regions').then((m) => { (window as unknown as { __regions: RegionDef[] }).__regions = m.REGIONS; });

showPlaceholder();
