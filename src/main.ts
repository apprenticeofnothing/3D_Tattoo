import './style.css';
import { Euler, Mesh, Object3D, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import { fitToHeight } from './body/fit';
import { makePlaceholderBody } from './body/placeholder';
import { locateRegion, REGIONS, type RegionDef } from './body/regions';
import { loadBodyFiles } from './io/loadMesh';
import { createPicker } from './ui/picker';
import { createSheet } from './ui/sheet';
import { Panel } from './ui/panel';
import { attachGestures, type DragKind } from './ui/gestures';
import { Viewer, type CompareSide } from './viewer/Viewer';
import { SelectionGizmo } from './viewer/SelectionGizmo';
import { MeasureOverlay } from './viewer/MeasureOverlay';
import { circumferenceAt, distanceOnSkin, type SurfacePoint } from './mapping/measure';
import { surfaceFromObject, triangleForHit, type SurfaceMesh } from './mesh/topology';
import { DesignStore, type DesignEntry } from './app/designs';
import { History, newId, type PlacementData, type ProjectData } from './app/project';
import { PlacedDesign, nearestTriangle, pointFromBary, type Placement } from './mapping/placements';
import { BuilderBody, defaultParams, loadBodyData, presetParamsAtHeight, SKIN_TONES, type Appearance, type BodyData, type BodyParams, type PresetMeta } from './body/builder';
import { BodyPanel } from './ui/bodyPanel';

const HEIGHT_KEY = 'tattoo.heightCm';
const PROJECT_KEY = 'tattoo.project.v1';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app'), stage = $('stage'), status = $('status'), hint = $('hint');
const fileInput = $<HTMLInputElement>('file');
const designInput = $<HTMLInputElement>('design-file');
const projectInput = $<HTMLInputElement>('project-file');

let heightCm = Math.max(50, Math.min(250, Number(localStorage.getItem(HEIGHT_KEY)) || 193));
const heightM = () => heightCm / 100;

const viewer = new Viewer(stage);
const gizmo = new SelectionGizmo();
viewer.scene.add(gizmo.group);
const measureOverlay = new MeasureOverlay();
viewer.scene.add(measureOverlay.group);
const designs = new DesignStore();
const history = new History();
let surface: SurfaceMesh | null = null;
let bodyLabel = 'Placeholder body';
let bodyInfo = '';
let bodyTriangles = 0;
const placed: PlacedDesign[] = [];
let selected: PlacedDesign | null = null;
let pending: DesignEntry | null = null; // design waiting for a tap
let restorePending: ProjectData | null = null;
let compare = false;
// Tape measure
let measuring: null | 'distance' | 'around' = null;
let measureFirst: SurfacePoint | null = null;
// Loaded scan and its manual orientation (scans come out of photogrammetry in arbitrary poses).
type UpAxis = 'y' | 'z' | 'x' | '-y' | '-z' | '-x';
const UP_CYCLE: UpAxis[] = ['y', 'z', 'x', '-y', '-z', '-x'];
let scanObject: Object3D | null = null;
let scanInfo = { triangles: 0, textured: false };
let orient: { up: UpAxis; turn: number } = { up: 'y', turn: 0 };
let orientManual = false;
let lighting: 'studio' | 'flat' | 'auto' = (localStorage.getItem('tattoo.lighting') as 'studio' | 'flat' | 'auto') || 'auto';
// Body builder (MakeHuman-derived bodies shaped with sliders).
type BodySource = 'builder' | 'scan' | 'mannequin';
const BUILDER_KEY = 'tattoo.builder.v1';
interface BuilderState { params: BodyParams; appearance: Appearance; presetId: string | null; base?: BodyParams | null }
let bodySource: BodySource = 'builder';
let bodyData: BodyData | null = null;
let builder: BuilderBody | null = null;
let builderState: BuilderState | null = null;
let builderStored = false;
try {
  const raw = localStorage.getItem(BUILDER_KEY);
  if (raw) { builderState = JSON.parse(raw) as BuilderState; builderStored = true; }
} catch { builderState = null; }
let bodyPanel: BodyPanel | null = null;

function setStatus(text: string) { status.textContent = text; }
function bodyStatus() { setStatus(`${bodyLabel} · ${heightCm} cm${bodyInfo}`); }

// ---------- Body ----------

function clearPlacements() {
  for (const d of placed) { viewer.scene.remove(d.decal.mesh); d.dispose(); }
  placed.length = 0;
  select(null);
}

/**
 * Rebuild the mapping surface after the body changed. Designs carry over:
 * exactly (same triangle and barycentric spot) when the mesh connectivity is
 * unchanged, as with the body builder; otherwise re-fitted by location.
 */
function afterBodyChange(opts: { frame?: boolean } = {}) {
  const body = viewer.getBody()!;
  const prev = surface;
  const carry = !restorePending && placed.length ? projectData() : null;
  surface = surfaceFromObject(body);
  bodyTriangles = surface.indices.length / 3;
  if (opts.frame !== false) viewer.frameBody(heightM());
  if (restorePending) { clearPlacements(); const data = restorePending; restorePending = null; void applyProject(data); return; }
  if (carry && prev && prev.topology && prev.topology === surface.topology && prev.indices.length === surface.indices.length) {
    for (const d of placed) {
      const p = d.placement;
      if (p.bary) p.point = pointFromBary(surface, p.tri, p.bary);
      d.decal.mesh.visible = !p.hidden;
      recompute(d, true);
    }
    history.replaceCurrent(snapshot());
    autosave();
    return;
  }
  clearPlacements();
  if (carry) void applyProject(carry);
  else commit();
}

// ---------- Body builder ----------

function presetById(id: string | null): PresetMeta | undefined { return bodyData?.meta.presets.find((p) => p.id === id); }

function saveBuilderState() {
  if (!builderState) return;
  try { localStorage.setItem(BUILDER_KEY, JSON.stringify(builderState)); } catch { /* ignore */ }
}

function builderLabel(): string {
  return presetById(builderState?.presetId ?? null)?.name ?? 'Custom body';
}

function refreshBodyPanel() {
  if (!bodyPanel || !builderState) return;
  bodyPanel.update({ source: bodySource, params: builderState.params, appearance: builderState.appearance, presetId: builderState.presetId, base: builderState.base ?? null, heightCm, bmi: builder ? builder.bmi() : null });
}

/** Show the builder body with the current settings. */
function showBuilder(opts: { frame?: boolean } = {}) {
  if (!bodyData || !builderState) { showPlaceholder(); return; }
  if (!builder) builder = new BuilderBody(bodyData, builderState.params);
  builder.appearance = builderState.appearance;
  builder.update(builderState.params, heightM());
  builder.mesh.updateMatrixWorld(true);
  scanObject = null;
  bodySource = 'builder';
  if (viewer.getBody() !== builder.mesh) viewer.setBody(builder.mesh); else viewer.requestRender();
  applyLighting();
  bodyLabel = builderLabel();
  bodyInfo = ` · BMI ≈ ${builder.bmi().bmi.toFixed(1)}`;
  afterBodyChange(opts);
  bodyStatus();
  refreshBodyPanel();
}

let settleTimer = 0;
/** Slider moved: reshape the body now, re-anchor the designs when the hand stops. */
function setBuilderParams(params: BodyParams, live: boolean) {
  if (!builderState || !bodyData) return;
  builderState.params = params;
  builderState.presetId = null;
  if (bodySource !== 'builder' || !builder) { showBuilder(); return; }
  builder.update(params, heightM());
  viewer.requestRender();
  // Decals are computed on the old shape; hide them until the shape settles.
  for (const d of placed) d.decal.mesh.visible = false;
  gizmo.set(null, null);
  bodyLabel = builderLabel();
  bodyInfo = ` · BMI ≈ ${builder.bmi().bmi.toFixed(1)}`;
  bodyStatus();
  refreshBodyPanel();
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    saveBuilderState();
    afterBodyChange({ frame: false });
    for (const d of placed) d.decal.mesh.visible = !d.placement.hidden;
    updateGizmo();
  }, live ? 350 : 0);
}

function choosePreset(p: PresetMeta) {
  if (!builderState || !bodyData) return;
  builderState.params = presetParamsAtHeight(bodyData, p, heightM());
  builderState.base = JSON.parse(JSON.stringify(builderState.params));
  builderState.presetId = p.id;
  saveBuilderState();
  showBuilder({ frame: bodySource !== 'builder' });
}

function setAppearance(a: Appearance) {
  if (!builderState) return;
  builderState.appearance = a;
  saveBuilderState();
  builder?.setAppearance(a);
  viewer.requestRender();
  refreshBodyPanel();
}

function openBodyPanel() {
  if (!builderState) { setStatus('The body builder is not available (its data did not load).'); return; }
  if (!bodyPanel) {
    bodyPanel = new BodyPanel(stage, bodyData, { source: bodySource, params: builderState.params, appearance: builderState.appearance, presetId: builderState.presetId, base: builderState.base ?? null, heightCm, bmi: builder ? builder.bmi() : null }, {
      onParams: setBuilderParams,
      onPreset: choosePreset,
      onAppearance: setAppearance,
      onHeight: (cm) => setHeight(cm),
      onUseBuilder: () => showBuilder(),
      onLoadScan: () => fileInput.click(),
      onClose: closeBodyPanel,
    });
  }
  refreshBodyPanel();
  bodyPanel.show();
  stage.classList.add('body-open');
  $('btn-shape').classList.add('active');
  updateViewInsets();
}

/** Centre the body in the part of the screen the body panel leaves free. */
let insetBottom = 0;
function updateViewInsets() {
  const before = insetBottom;
  if (!bodyPanel?.open) { viewer.setInsets({}); insetBottom = 0; }
  else {
    const r = bodyPanel.el.getBoundingClientRect(), s = stage.getBoundingClientRect();
    if (r.width < s.width * 0.9) { viewer.setInsets({ right: r.width }); insetBottom = 0; }
    else { viewer.setInsets({ bottom: r.height }); insetBottom = r.height; }
  }
  // A bottom sheet changes how much height is free: re-frame the whole body.
  if (insetBottom !== before) viewer.frameBody(heightM());
}
window.addEventListener('resize', updateViewInsets);

function closeBodyPanel() {
  bodyPanel?.hide();
  stage.classList.remove('body-open');
  $('btn-shape').classList.remove('active');
  updateViewInsets();
}

function showPlaceholder() {
  setStatus('Building placeholder body…');
  setTimeout(() => {
    const { mesh, triangles } = makePlaceholderBody(heightM(), 0.01);
    scanObject = null;
    bodySource = 'mannequin';
    viewer.setBody(mesh);
    applyLighting();
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
    scanObject = loaded.object;
    scanInfo = { triangles: loaded.triangles, textured: loaded.textured };
    bodyLabel = files.find((f) => /\.(glb|gltf|obj|ply)$/i.test(f.name))?.name ?? 'Scan';
    // Remember how this file was last oriented.
    const saved = localStorage.getItem(`tattoo.orient.${bodyLabel}`);
    if (saved) { try { orient = JSON.parse(saved); orientManual = true; } catch { orient = { up: 'y', turn: 0 }; orientManual = false; } }
    else { orient = { up: 'y', turn: 0 }; orientManual = false; }
    applyScan();
  } catch (err) {
    console.error(err);
    setStatus(`Could not load: ${(err as Error).message}`);
  }
}

/** Quaternion that maps the chosen up axis to +Y, then turns about Y. */
function orientationQuaternion(o: { up: UpAxis; turn: number }): Quaternion {
  const up = new Quaternion();
  const d = Math.PI / 2;
  switch (o.up) {
    case 'y': break;
    case 'z': up.setFromEuler(new Euler(-d, 0, 0)); break;
    case '-z': up.setFromEuler(new Euler(d, 0, 0)); break;
    case 'x': up.setFromEuler(new Euler(0, 0, d)); break;
    case '-x': up.setFromEuler(new Euler(0, 0, -d)); break;
    case '-y': up.setFromEuler(new Euler(Math.PI, 0, 0)); break;
  }
  const turn = new Quaternion().setFromEuler(new Euler(0, (o.turn * Math.PI) / 2, 0));
  return turn.multiply(up);
}

/** (Re)build the fitted body from the loaded scan with the current orientation and height. */
function applyScan() {
  if (!scanObject) return;
  if (scanObject.parent) scanObject.parent.remove(scanObject);
  const holder = new Object3D();
  holder.quaternion.copy(orientationQuaternion(orient));
  holder.add(scanObject);
  const { group, info } = fitToHeight(holder, heightM(), { autoUpright: !orientManual });
  // If the automatic upright fix fired, record it so manual turns start from what is on screen.
  if (info.rotatedToYUp && !orientManual) orient = { up: 'z', turn: orient.turn };
  viewer.setBody(group);
  bodySource = 'scan';
  refreshBodyPanel();
  applyLighting();
  const notes = [scanInfo.textured ? 'textured' : '', info.rotatedToYUp ? 'rotated to upright' : '', orientManual ? `up ${orient.up}, turned ${orient.turn * 90}°` : ''].filter(Boolean);
  bodyInfo = ` · ${(scanInfo.triangles / 1000).toFixed(0)}k triangles${notes.length ? ' · ' + notes.join(' · ') : ''}`;
  afterBodyChange();
  bodyStatus();
}

function applyLighting() {
  const mode = lighting === 'auto' ? (scanObject && scanInfo.textured ? 'flat' : 'studio') : lighting;
  viewer.setLighting(mode);
}

function changeOrientation(change: (o: { up: UpAxis; turn: number }) => void) {
  if (!scanObject) { setStatus('Orientation applies to a loaded scan. The placeholder is already upright.'); return; }
  change(orient);
  orient.turn = ((orient.turn % 4) + 4) % 4;
  orientManual = true;
  localStorage.setItem(`tattoo.orient.${bodyLabel}`, JSON.stringify(orient));
  applyScan();
}

function setHeight(cm: number) {
  heightCm = Math.max(50, Math.min(250, Math.round(cm)));
  localStorage.setItem(HEIGHT_KEY, String(heightCm));
  const body = viewer.getBody();
  refreshBodyPanel();
  if (!body) return;
  if (bodySource === 'builder') {
    // An untouched preset keeps its BMI at the new height; custom bodies keep their sliders.
    const preset = presetById(builderState?.presetId ?? null);
    if (preset && builderState && bodyData) { builderState.params = presetParamsAtHeight(bodyData, preset, heightM()); builderState.base = JSON.parse(JSON.stringify(builderState.params)); saveBuilderState(); }
    showBuilder({ frame: true }); // same mesh connectivity: designs stay put
    return;
  }
  // Keep the placements: they are re-applied by location after the body is rebuilt.
  restorePending = projectData();
  if ((body as Mesh).name === 'placeholder-body') showPlaceholder();
  else applyScan();
}

function goTo(def: RegionDef) {
  if (!surface) return;
  const labels = surface.labels && surface.partNames ? { labels: surface.labels, names: surface.partNames } : undefined;
  const pose = locateRegion(def, surface.positions, heightM(), labels);
  if (!pose) { setStatus(`Could not find ${def.label} on this body`); return; }
  viewer.flyTo(pose);
  setStatus(def.label);
}

// ---------- Picking ----------

const raycaster = new Raycaster();
function ndcAt(clientX: number, clientY: number): Vector2 {
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  return new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
}
function pickSurface(clientX: number, clientY: number): { tri: number; point: [number, number, number] } | null {
  if (!surface) return null;
  raycaster.setFromCamera(ndcAt(clientX, clientY), viewer.camera);
  const hits = raycaster.intersectObjects(viewer.bodyMeshes(), false);
  const hit = hits.find((h) => h.faceIndex !== undefined && h.faceIndex !== null);
  if (!hit) return null;
  try {
    return { tri: triangleForHit(surface, hit.object as Mesh, hit.faceIndex!), point: [hit.point.x, hit.point.y, hit.point.z] };
  } catch { return null; }
}
function pickDesign(clientX: number, clientY: number): PlacedDesign | null {
  raycaster.setFromCamera(ndcAt(clientX, clientY), viewer.camera);
  const meshes = placed.filter((d) => d.decal.mesh.visible).map((d) => d.decal.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  for (const h of hits) {
    const d = placed.find((x) => x.decal.mesh === h.object);
    if (!d || !h.uv) continue;
    const inV = h.uv.y >= 0 && h.uv.y <= 1;
    const inU = d.placement.wrap || (h.uv.x >= 0 && h.uv.x <= 1);
    if (inV && inU) return d;
  }
  return null;
}
function toScreen(p: [number, number, number]): { x: number; y: number } {
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  const v = new Vector3(...p).project(viewer.camera);
  return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
}

// ---------- Placements ----------

function makePlaced(data: PlacementData): PlacedDesign | null {
  const entry = designs.get(data.designId);
  if (!entry) return null;
  const placement: Placement = { ...data, design: entry.image };
  const d = new PlacedDesign(placement);
  d.decal.mesh.visible = !placement.hidden;
  placed.push(d);
  viewer.scene.add(d.decal.mesh);
  return d;
}

function place(entry: DesignEntry, tri: number, point: [number, number, number]): PlacedDesign | null {
  const data: PlacementData = {
    id: newId('p'), designId: entry.source.id, tri, point, normal: [0, 0, 1], rotation: 0,
    widthCm: entry.defaultWidthCm, mirror: false, wrap: false, opacity: 1, mode: 'stencil', option: 'both',
  };
  const d = makePlaced(data);
  if (!d) return null;
  select(d);
  recompute(d, true);
  commit();
  return d;
}

function removeDesign(d: PlacedDesign) {
  viewer.scene.remove(d.decal.mesh); d.dispose();
  placed.splice(placed.indexOf(d), 1);
  if (selected === d) select(placed[placed.length - 1] ?? null); else panel.setDesigns(placed, selected?.placement.id ?? null);
  viewer.requestRender();
  commit();
}

function duplicateSelected() {
  if (!selected) return;
  const data = selected.toData();
  data.id = newId('p');
  const d = makePlaced(data);
  if (!d) return;
  select(d);
  recompute(d, true);
  commit();
  setStatus('Duplicated. Drag the copy to where you want it.');
}

const busy = new Map<PlacedDesign, { again: boolean; exact: boolean }>();
function recompute(d: PlacedDesign, exact: boolean) {
  if (!surface) return;
  const b = busy.get(d);
  if (b) { b.again = true; b.exact = b.exact || exact; return; }
  busy.set(d, { again: false, exact });
  requestAnimationFrame(() => {
    const state = busy.get(d)!;
    try {
      if (placed.includes(d)) {
        d.update(surface!, state.exact);
        if (d === selected) { panel.renderReadout(d); updateGizmo(); }
        viewer.requestRender();
      }
    } catch (err) {
      console.error(err);
      setStatus(`Mapping failed: ${(err as Error).message}`);
    } finally {
      busy.delete(d);
      if (state.again) recompute(d, state.exact);
    }
  });
}
const anyBusy = () => busy.size > 0;

function select(d: PlacedDesign | null) {
  selected = d;
  panel.show(d);
  panel.setDesigns(placed, d?.placement.id ?? null);
  updateGizmo();
  viewer.requestRender();
}

function updateGizmo() {
  if (!selected || !surface || compare || !selected.result || selected.placement.hidden) { gizmo.set(null, null); return; }
  gizmo.set(selected.outline(surface), selected.handles(surface));
}

/** Apply a field change to the selected design. */
function changeSelected(patch: Partial<PlacementData>, doCommit: boolean) {
  if (!selected) return;
  const p = selected.placement;
  const needsGeometry = ['widthCm', 'rotation', 'mirror', 'wrap'].some((k) => k in patch);
  Object.assign(p, patch);
  if ('hidden' in patch) { selected.decal.mesh.visible = !p.hidden; updateGizmo(); }
  if ('opacity' in patch) selected.decal.setOpacity(p.opacity);
  if ('mode' in patch) selected.decal.setMode(p.mode);
  if (needsGeometry) recompute(selected, doCommit); else { panel.show(selected); viewer.requestRender(); }
  if (!needsGeometry) panel.renderReadout(selected);
  if (doCommit) { panel.show(selected); commit(); }
}

// ---------- History and persistence ----------

function snapshot(): PlacementData[] { return placed.map((d) => d.toData()); }

function projectData(): ProjectData {
  const used = new Set(placed.map((d) => d.placement.designId));
  return {
    version: 1, savedAt: new Date().toISOString(), heightCm,
    body: {
      label: bodyLabel, triangles: bodyTriangles, topology: surface?.topology,
      builder: bodySource === 'builder' && builderState ? JSON.parse(JSON.stringify(builderState)) : undefined,
    },
    designs: [...designs.entries.values()].filter((e) => used.has(e.source.id)).map((e) => e.source),
    placements: snapshot(), selectedId: selected?.placement.id ?? null,
  };
}

function updateUndoButtons() {
  ($('btn-undo') as HTMLButtonElement).disabled = !history.canUndo;
  ($('btn-redo') as HTMLButtonElement).disabled = !history.canRedo;
}

let autosaveWarned = false;
function autosave() {
  try { localStorage.setItem(PROJECT_KEY, JSON.stringify(projectData())); }
  catch {
    if (!autosaveWarned) { autosaveWarned = true; setStatus('Autosave is off: the designs are too large for browser storage. Use More, Save project.'); }
  }
}

function commit() {
  history.push(snapshot());
  updateUndoButtons();
  autosave();
}

/** Rebuild the scene from a placement list (undo/redo). */
function applySnapshot(list: PlacementData[]) {
  const keepIds = new Set(list.map((p) => p.id));
  for (const d of [...placed]) if (!keepIds.has(d.placement.id)) { viewer.scene.remove(d.decal.mesh); d.dispose(); placed.splice(placed.indexOf(d), 1); }
  const byId = new Map(placed.map((d) => [d.placement.id, d]));
  const order: PlacedDesign[] = [];
  for (const data of list) {
    let d = byId.get(data.id);
    if (d) {
      const changed = JSON.stringify(d.toData()) !== JSON.stringify(data);
      Object.assign(d.placement, data);
      d.decal.mesh.visible = !data.hidden;
      if (changed) recompute(d, true);
    } else {
      d = makePlaced(data) ?? undefined;
      if (d) recompute(d, true);
    }
    if (d) order.push(d);
  }
  placed.length = 0; placed.push(...order);
  const sel = selected && placed.includes(selected) ? selected : placed[placed.length - 1] ?? null;
  select(sel);
  updateUndoButtons();
  autosave();
}

function undo() { const s = history.undo(); if (s) { applySnapshot(s); setStatus('Undo'); } }
function redo() { const s = history.redo(); if (s) { applySnapshot(s); setStatus('Redo'); } }

/** Restore designs and placements from a saved project onto the current body. */
async function applyProject(data: ProjectData) {
  if (!surface) return;
  try {
    for (const src of data.designs) await designs.addSource(src);
  } catch (err) {
    setStatus(`Could not restore a design: ${(err as Error).message}`);
  }
  const sameBody = data.body.triangles === bodyTriangles;
  const sameTopology = !!data.body.topology && data.body.topology === surface.topology && sameBody;
  let refitted = 0;
  for (const p of data.placements) {
    if (!designs.get(p.designId)) continue;
    if (sameTopology && p.bary && p.tri >= 0 && p.tri < bodyTriangles) {
      p.point = pointFromBary(surface, p.tri, p.bary);
      const d = makePlaced(p);
      if (d) recompute(d, true);
      continue;
    }
    // Validate the anchor triangle; fall back to the nearest triangle to the saved point.
    let ok = sameBody && p.tri >= 0 && p.tri < bodyTriangles;
    if (ok) {
      const I = surface.indices, P = surface.positions;
      const a = I[p.tri * 3] * 3, b = I[p.tri * 3 + 1] * 3, c = I[p.tri * 3 + 2] * 3;
      const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      ok = Math.hypot(cx - p.point[0], cy - p.point[1], cz - p.point[2]) < 0.03;
    }
    if (!ok) {
      const n = nearestTriangle(surface, p.point);
      if (n.dist > 0.05) continue; // nowhere near this body
      p.tri = n.tri; refitted++;
    }
    const d = makePlaced(p);
    if (d) recompute(d, true);
  }
  const sel = placed.find((d) => d.placement.id === data.selectedId) ?? placed[placed.length - 1] ?? null;
  select(sel);
  commit();
  if (placed.length) setStatus(`Restored ${placed.length} design${placed.length === 1 ? '' : 's'}${refitted ? ` (${refitted} re-fitted by location)` : ''}`);
}

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');

function saveProject() {
  const data = projectData();
  download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `tattoo-project-${stamp()}.json`);
  setStatus('Project saved (designs and placements, no body data)');
}

async function openProject(file: File) {
  try {
    const data = JSON.parse(await file.text()) as ProjectData;
    if (data.version !== 1 || !Array.isArray(data.placements)) throw new Error('not a tattoo project file');
    clearPlacements();
    if (data.body.builder && bodyData) {
      builderState = JSON.parse(JSON.stringify(data.body.builder)) as BuilderState;
      saveBuilderState();
      if (data.heightCm) { heightCm = data.heightCm; localStorage.setItem(HEIGHT_KEY, String(heightCm)); }
      restorePending = data;
      showBuilder();
      return;
    }
    if (data.heightCm && data.heightCm !== heightCm) { restorePending = data; setHeight(data.heightCm); }
    else await applyProject(data);
  } catch (err) {
    setStatus(`Could not open project: ${(err as Error).message}`);
  }
}

async function takePhoto() {
  try {
    // Hide the selection outline and handles for a clean image.
    const wasVisible = gizmo.group.visible;
    gizmo.group.visible = false;
    let blob: Blob;
    try { blob = await viewer.screenshot(); } finally { gizmo.group.visible = wasVisible; viewer.requestRender(); }
    const file = new File([blob], `tattoo-${stamp()}.png`, { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try { await nav.share({ files: [file], title: 'Tattoo preview' }); setStatus('Photo shared'); return; } catch { /* user cancelled: fall through to download */ }
    }
    download(blob, file.name);
    setStatus('Photo saved');
  } catch (err) {
    setStatus(`Could not take photo: ${(err as Error).message}`);
  }
}

// ---------- Compare ----------

function setCompare(on: boolean) {
  compare = on;
  $('btn-compare').classList.toggle('active', on);
  $('compare-labels').classList.toggle('hidden', !on);
  const stacked = window.innerWidth < window.innerHeight;
  $('compare-labels').classList.toggle('stacked', stacked);
  viewer.compareStacked = stacked;
  viewer.compareFilter = on ? (side: CompareSide) => {
    for (const d of placed) d.decal.mesh.visible = !d.placement.hidden && (d.placement.option === 'both' || d.placement.option === (side === 'left' ? 'A' : 'B'));
  } : null;
  if (!on) for (const d of placed) d.decal.mesh.visible = !d.placement.hidden;
  updateGizmo();
  viewer.requestRender();
  if (on) setStatus('Compare: left shows A, right shows B. Set each design\'s "Compare as" in its panel.');
}

// ---------- Tape measure ----------

function setMeasure(mode: null | 'distance' | 'around') {
  measuring = mode;
  measureFirst = null;
  $('btn-measure').classList.toggle('active', !!mode);
  $('measure-bar').classList.toggle('hidden', !mode);
  if (!mode) { measureOverlay.clear(); viewer.requestRender(); return; }
  if (selected) select(null);
  $('measure-bar').querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.measure === mode));
  $('measure-text').textContent = mode === 'distance' ? 'Tap two points on the skin' : 'Tap a point on an arm, leg or the torso';
  measureOverlay.clear(); viewer.requestRender();
}

function measureTap(hit: SurfacePoint) {
  if (!surface || !measuring) return;
  const fmt = (m: number) => `${(m * 100).toFixed(1)} cm`;
  if (measuring === 'around') {
    const c = circumferenceAt(surface, hit);
    if (!c) { $('measure-text').textContent = 'No closed loop here. Try a point on a limb.'; measureOverlay.clear(); viewer.requestRender(); return; }
    measureOverlay.set(c.points, [hit.point], true);
    $('measure-text').innerHTML = `Around: <b>${fmt(c.length)}</b>${c.fromShape ? '' : ' (horizontal cut)'}`;
    viewer.requestRender();
    return;
  }
  if (!measureFirst) {
    measureFirst = hit;
    measureOverlay.set([hit.point], [hit.point]);
    $('measure-text').textContent = 'Now tap the second point';
    viewer.requestRender();
    return;
  }
  const r = distanceOnSkin(surface, measureFirst, hit);
  if (!r) { $('measure-text').textContent = 'Too far apart for one measurement. Tap a nearer second point.'; measureFirst = null; return; }
  measureOverlay.set(r.path, [measureFirst.point, hit.point]);
  $('measure-text').innerHTML = `Along the skin: <b>${fmt(r.geodesic)}</b> · straight line ${fmt(r.straight)}. Tap again to start over.`;
  measureFirst = null;
  viewer.requestRender();
}

$('btn-measure').addEventListener('click', () => setMeasure(measuring ? null : 'distance'));
$('measure-done').addEventListener('click', () => setMeasure(null));
$('measure-bar').querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => b.addEventListener('click', () => setMeasure(b.dataset.measure as 'distance' | 'around')));

// ---------- Gestures ----------

type Drag = { kind: DragKind; offset: { dx: number; dy: number } };
let drag: Drag | null = null;
const HANDLE_RADIUS = 30;

function nearHandle(x: number, y: number, p: [number, number, number] | null): boolean {
  if (!p) return false;
  const s = toScreen(p);
  return Math.hypot(s.x - x, s.y - y) < HANDLE_RADIUS;
}

attachGestures(viewer.renderer.domElement, viewer.controls, {
  hitTest(x, y) {
    if (compare || !surface || measuring) return null;
    if (selected?.result) {
      const h = selected.handles(surface);
      if (nearHandle(x, y, h.rotate)) return 'rotate';
      if (nearHandle(x, y, h.scale)) return 'scale';
    }
    if (pending) return null; // placing: let taps through, camera otherwise
    const d = pickDesign(x, y);
    if (d) { if (d !== selected) select(d); return 'move'; }
    return null;
  },
  onTap(x, y) {
    if (measuring) { const hit = pickSurface(x, y); if (hit) measureTap(hit); return; }
    if (pending) {
      const hit = pickSurface(x, y);
      if (!hit) { setStatus('That tap missed the body. Try again.'); return; }
      const entry = pending; pending = null; hint.classList.add('hidden');
      place(entry, hit.tri, hit.point);
      return;
    }
    const d = pickDesign(x, y);
    if (d) select(d); else if (selected) select(null);
  },
  onDragStart(kind, x, y) {
    if (!selected || !surface) return;
    let offset = { dx: 0, dy: 0 };
    if (kind === 'move') {
      const c = toScreen(selected.placement.point);
      offset = { dx: c.x - x, dy: c.y - y };
    }
    drag = { kind, offset };
  },
  onDragMove(kind, x, y) {
    if (!selected || !surface || !drag) return;
    const p = selected.placement;
    if (kind === 'move') {
      const hit = pickSurface(x + drag.offset.dx, y + drag.offset.dy);
      if (!hit) return;
      p.tri = hit.tri; p.point = hit.point;
      recompute(selected, false);
      return;
    }
    const hit = pickSurface(x, y);
    if (!hit || !selected.result || selected.result.rotation !== p.rotation) return; // wait for a fresh patch
    const uv = selected.uvAt(surface, hit.tri, hit.point);
    if (!uv) return;
    if (kind === 'rotate') {
      const phi = Math.atan2(uv[0], uv[1]); // angle of the finger from the design's up axis
      let r = p.rotation - phi;
      r = Math.atan2(Math.sin(r), Math.cos(r));
      p.rotation = r;
    } else {
      p.widthCm = Math.round(Math.min(150, Math.max(1, selected.widthForCornerRadius(Math.hypot(uv[0], uv[1])))) * 10) / 10;
    }
    panel.show(selected);
    recompute(selected, false);
  },
  onDragEnd(_kind, cancelled) {
    drag = null;
    if (!selected) return;
    recompute(selected, true);
    if (!cancelled) commit();
    panel.show(selected);
  },
});
viewer.controls.addEventListener('change', () => { /* handles are sprites; nothing to do */ });

// ---------- UI wiring ----------

const panel = new Panel(stage, {
  onSelect: (id) => select(placed.find((d) => d.placement.id === id) ?? null),
  onChange: changeSelected,
  onDuplicate: duplicateSelected,
  onRemove: () => { if (selected) removeDesign(selected); },
});
if (window.innerWidth < 700) panel.setCollapsed(true);

function startPlacing(entry: DesignEntry) {
  pending = entry;
  hint.textContent = `Tap the body where the centre of "${entry.source.name}" should go`;
  hint.classList.remove('hidden');
  if (selected) select(null);
}

const picker = createPicker(app, goTo);
const addSheet = createSheet(app, 'Add a design');
const moreSheet = createSheet(app, 'More');
const orientSheet = createSheet(app, 'Orientation of the scan');

$('btn-add').addEventListener('click', () => addSheet.open([
  { label: 'From a file', hint: 'SVG or PNG', onClick: () => designInput.click() },
  { label: 'Test pattern', hint: '10 cm grid with a 6 cm circle', onClick: () => void designs.addTestPattern().then(startPlacing) },
  ...[...designs.entries.values()].filter((e) => e.source.name !== 'test-pattern.svg').map((e) => ({ label: `Place again: ${e.source.name}`, onClick: () => startPlacing(e) })),
]));
$('btn-parts').addEventListener('click', picker.open);
$('btn-shape').addEventListener('click', () => (bodyPanel?.open ? closeBodyPanel() : openBodyPanel()));
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-compare').addEventListener('click', () => setCompare(!compare));
$('btn-photo').addEventListener('click', () => void takePhoto());
$('btn-more').addEventListener('click', () => moreSheet.open([
  { label: 'Body shape', hint: 'Presets and sliders', onClick: openBodyPanel },
  { label: 'Load my scan', hint: 'GLB, OBJ or PLY from this device', onClick: () => fileInput.click() },
  { label: 'Save project', hint: 'Designs and placements as a file', onClick: saveProject },
  { label: 'Open project', hint: 'A saved .json file', onClick: () => projectInput.click() },
  { label: 'Reset view', onClick: () => viewer.frameBody(heightM()) },
  { label: 'Capture assistant', hint: 'Guided photo session for the scan', onClick: () => { location.href = 'capture.html'; } },
  { label: `Lighting: ${lighting}`, hint: 'auto = flat for textured scans, studio otherwise', onClick: () => { lighting = lighting === 'auto' ? 'studio' : lighting === 'studio' ? 'flat' : 'auto'; localStorage.setItem('tattoo.lighting', lighting); applyLighting(); setStatus(`Lighting: ${lighting}`); } },
  { label: 'Orientation', hint: 'Stand the scan up, turn it to face you', onClick: () => orientSheet.open([
    { label: 'Turn left 90°', onClick: () => changeOrientation((o) => { o.turn -= 1; }) },
    { label: 'Turn right 90°', onClick: () => changeOrientation((o) => { o.turn += 1; }) },
    { label: 'Turn around 180°', hint: 'Front and back swapped', onClick: () => changeOrientation((o) => { o.turn += 2; }) },
    { label: 'Change which axis is up', hint: `Now: ${orient.up}. Cycles through all six.`, onClick: () => changeOrientation((o) => { o.up = UP_CYCLE[(UP_CYCLE.indexOf(o.up) + 1) % UP_CYCLE.length]; }) },
    { label: 'Reset orientation', onClick: () => changeOrientation((o) => { o.up = 'y'; o.turn = 0; }) },
  ]) },
  { label: `Height: ${heightCm} cm`, hint: 'Used to scale the body', onClick: () => { const v = window.prompt('Your height in cm', String(heightCm)); if (v && Number(v)) setHeight(Number(v)); } },
  { label: 'Clear all designs', danger: true, onClick: () => { if (placed.length && window.confirm('Remove all placed designs?')) { clearPlacements(); commit(); } } },
]));
fileInput.addEventListener('change', () => { void loadFiles(Array.from(fileInput.files ?? [])); fileInput.value = ''; });
designInput.addEventListener('change', async () => {
  const f = designInput.files?.[0]; designInput.value = '';
  if (!f) return;
  try { startPlacing(await designs.addFile(f)); } catch (err) { setStatus(`Could not read design: ${(err as Error).message}`); }
});
projectInput.addEventListener('change', () => { const f = projectInput.files?.[0]; projectInput.value = ''; if (f) void openProject(f); });
stage.addEventListener('dragover', (e) => { e.preventDefault(); });
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  const design = files.find((f) => /\.(svg|png|jpe?g|webp)$/i.test(f.name));
  const project = files.find((f) => /\.json$/i.test(f.name));
  if (project) void openProject(project);
  else if (design && files.length === 1) designs.addFile(design).then(startPlacing).catch((err) => setStatus(`Could not read design: ${(err as Error).message}`));
  else void loadFiles(files);
});
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeDesign(selected); }
  else if (e.key === 'Escape') { if (measuring) setMeasure(null); else if (pending) { pending = null; hint.classList.add('hidden'); } else select(null); }
  else if (selected && surface && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '[', ']'].includes(e.key)) {
    e.preventDefault();
    const p = selected.placement;
    if (e.key === '[' || e.key === ']') {
      const step = (e.shiftKey ? 10 : 1) * (Math.PI / 180) * (e.key === ']' ? -1 : 1);
      p.rotation = Math.atan2(Math.sin(p.rotation + step), Math.cos(p.rotation + step));
    } else {
      // Move 1 mm (10 mm with Shift) along the design's own axes, on the skin.
      const step = e.shiftKey ? 0.01 : 0.001;
      const du = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
      const dv = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
      const loc = selected.getLocator(surface);
      const hit = loc?.locateTri(du, dv);
      if (!hit) return;
      p.tri = hit.tri; p.point = hit.point;
    }
    recompute(selected, true);
    panel.show(selected);
    commit();
  }
});
window.addEventListener('resize', () => { if (compare) setCompare(true); });

// Restore the last session, then build the body.
try {
  const saved = localStorage.getItem(PROJECT_KEY);
  if (saved) { const data = JSON.parse(saved) as ProjectData; if (data.version === 1 && data.placements.length) restorePending = data; }
} catch { /* ignore */ }

// Small hook for automated checks.
(window as unknown as { __app: unknown }).__app = {
  placeTestAt: async (x: number, y: number) => { startPlacing(await designs.addTestPattern()); const hit = pickSurface(x, y); if (!hit) return false; pending = null; hint.classList.add('hidden'); place(designs.get([...designs.entries.keys()][0])!, hit.tri, hit.point); return true; },
  selected: () => selected,
  placed: () => placed,
  set: (fn: (d: PlacedDesign) => void) => { if (selected) { fn(selected); panel.show(selected); recompute(selected, true); commit(); } },
  goTo: (id: string) => { const def = REGIONS.find((r) => r.id === id); if (def) goTo(def); },
  busy: anyBusy,
  handles: () => (selected && surface ? selected.handles(surface) : null),
  toScreen,
  history: () => ({ canUndo: history.canUndo, canRedo: history.canRedo }),
  undo, redo, setCompare,
  orient: () => orient, changeOrientation, status: () => status.textContent,
  setMeasure, measureTap, pickSurface, measureText: () => $('measure-text').textContent,
  openBodyPanel, closeBodyPanel, choosePreset: (id: string) => { const p = presetById(id); if (p) choosePreset(p); },
  setBuilderParams, builderState: () => builderState, bodySource: () => bodySource,
  surfaceInfo: () => (surface ? { tris: surface.indices.length / 3, topology: surface.topology, labels: !!surface.labels } : null),
};

async function start() {
  setStatus('Loading bodies…');
  try {
    bodyData = await loadBodyData(import.meta.env.BASE_URL);
    if (!builderState || !builderState.params) {
      const first = bodyData.meta.presets[0];
      const params = presetParamsAtHeight(bodyData, first, heightM());
      builderState = { params, appearance: { skinTone: SKIN_TONES[2] }, presetId: first.id, base: JSON.parse(JSON.stringify(params)) };
    }
    builderState.params = { ...defaultParams(), ...builderState.params, details: { ...(builderState.params.details ?? {}) } };
    builderState.appearance = { skinTone: builderState.appearance?.skinTone ?? SKIN_TONES[2] };
    showBuilder();
    if (!builderStored && !restorePending) {
      openBodyPanel();
      setStatus('Choose a starting body, then adjust the sliders to match.');
    }
  } catch (err) {
    console.error(err);
    setStatus(`Body builder unavailable (${(err as Error).message}); using the simple mannequin.`);
    showPlaceholder();
  }
}
void start();
