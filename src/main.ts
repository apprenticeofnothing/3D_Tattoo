import './style.css';
import { Euler, Mesh, Object3D, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import { fitToHeight } from './body/fit';
import { makePlaceholderBody } from './body/placeholder';
import { limbAxis, locatePartSpot, locateRegion, regionForSpot, REGIONS, type PartSpot, type RegionDef } from './body/regions';
import { loadBodyFiles } from './io/loadMesh';
import { createPicker } from './ui/picker';
import { createSheet } from './ui/sheet';
import { Panel } from './ui/panel';
import { attachGestures, type DragKind } from './ui/gestures';
import { Viewer, type CompareSide } from './viewer/Viewer';
import { SelectionGizmo } from './viewer/SelectionGizmo';
import { MeasureOverlay } from './viewer/MeasureOverlay';
import { CoverOverlay } from './viewer/CoverOverlay';
import { coverage, sampleInk, sizeToCover, type InkSample } from './existing/coverage';
import { barycentric, computeExpMap, normalAt, tangentFrom } from './mapping/expmap';
import { JointHandles, type ArmSide, type JointId } from './viewer/JointHandles';
import { TurntableRing } from './viewer/TurntableRing';
import { wheelFactor } from './viewer/zoom';
import { ExportDialog, type ExportChoice } from './ui/exportDialog';
import { ExistingImport, type ImportAnalysis, type ImportResult } from './ui/existingImport';
import { autoGuides } from './existing/autoGuide';
import { detectPose } from './existing/poseModel';
import { renderSkin, type ScanTexture } from './existing/scanTrace';
import { extractInk } from './existing/inkExtract';
import { keepCentralInk } from './existing/flatten';
import { crop } from './existing/image';
import { rgbaToCanvas } from './ui/existingImport';
import { PatchLocator } from './mapping/locate';
import { describeHint, HALF_WIDTH, maskEdges, suggestFromPose, type PoseHint } from './existing/poseSuggest';
import type { Rgba } from './existing/image';
import { widthFromCircumference, widthFromVisibleWidth } from './existing/flatten';
import { sourceImage, stencilPdf, stencilPng, stencilSvg } from './export/stencil';
import { describeArea, describeRotation } from './export/placementText';
import { circumferenceAt, distanceOnSkin, type SurfacePoint } from './mapping/measure';
import { surfaceFromObject, triangleForHit, type SurfaceMesh } from './mesh/topology';
import { DesignStore, type DesignEntry } from './app/designs';
import { History, newId, type PlacementData, type ProjectData } from './app/project';
import { PlacedDesign, designTangent, nearestTriangle, pointFromBary, toDisplay, type Placement } from './mapping/placements';
import { BuilderBody, defaultParams, loadBodyData, presetParamsAtHeight, SKIN_TONES, type Appearance, type BodyData, type BodyParams, type PresetMeta } from './body/builder';
import { BodyPanel } from './ui/bodyPanel';
import { PosePanel } from './ui/posePanel';
import { isRestPose, type Pose } from './body/pose';

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
const jointHandles = new JointHandles();
viewer.scene.add(jointHandles.group);
const ring = new TurntableRing();
viewer.scene.add(ring.group);
const bodyCentre = () => new Vector3(0, heightM() * 0.5, 0);
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
interface BuilderState { params: BodyParams; appearance: Appearance; presetId: string | null; base?: BodyParams | null; pose?: Pose }
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
let posePanel: PosePanel | null = null;

function setStatus(text: string) { status.textContent = text; }
function bodyStatus() { setStatus(`${bodyLabel} · ${heightCm} cm${bodyInfo}`); }

/**
 * Positions of the body as shown. Mapping, stretch and measurements use the
 * rest pose (surface.positions); what the eye sees, and where taps land, is
 * the posed body. Both share vertex ids.
 */
function display(): Float32Array {
  if (surface && bodySource === 'builder' && builder && surface.topology && viewer.getBody() === builder.mesh) return builder.displayPositions();
  return surface ? surface.positions : new Float32Array(0);
}
const shown = (tri: number, p: [number, number, number]) => (surface ? toDisplay(surface, display(), tri, p) : p);

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
/**
 * The view turns around a point that must stay on the body (with a small
 * margin), so zooming or panning can never leave you looking at nothing.
 */
function updateViewBounds() {
  if (!surface) return;
  const D = display();
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < D.length; i += 3 * 5) {
    min.x = Math.min(min.x, D[i]); min.y = Math.min(min.y, D[i + 1]); min.z = Math.min(min.z, D[i + 2]);
    max.x = Math.max(max.x, D[i]); max.y = Math.max(max.y, D[i + 1]); max.z = Math.max(max.z, D[i + 2]);
  }
  const m = 0.04;
  viewer.setBounds(min.subScalar(m), max.addScalar(m));
}

function afterBodyChange(opts: { frame?: boolean } = {}) {
  const body = viewer.getBody()!;
  const prev = surface;
  const carry = !restorePending && placed.length ? projectData() : null;
  surface = bodySource === 'builder' && builder && body === builder.mesh ? builder.restSurface() : surfaceFromObject(body);
  bodyTriangles = surface.indices.length / 3;
  ring.setRadius(0.3 * heightM());
  updateViewBounds();
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
  builder.pose = builderState.pose ?? {};
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
  refreshPosePanel();
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
  closePosePanel();
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
  const panel = bodyPanel?.open ? bodyPanel.el : posePanel?.open ? posePanel.el : null;
  if (!panel) { viewer.setInsets({}); insetBottom = 0; }
  else {
    const r = panel.getBoundingClientRect(), s = stage.getBoundingClientRect();
    if (r.width < s.width * 0.9) { viewer.setInsets({ right: r.width }); insetBottom = 0; }
    else { viewer.setInsets({ bottom: r.height }); insetBottom = r.height; }
  }
  // A bottom sheet changes how much height is free: re-frame the whole body.
  if (insetBottom !== before) viewer.frameBody(heightM());
  jointHandles.setMagnification(viewer.spriteMagnification());
  gizmo.setMagnification(viewer.spriteMagnification());
}
window.addEventListener('resize', updateViewInsets);

// ---------- Arm pose ----------

function poseAvailable(): boolean { return bodySource === 'builder' && !!builder; }

/** Show joint handles while the pose panel is open on a built body. */
function updateJointHandles() {
  const on = !!posePanel?.open && poseAvailable() && !compare;
  jointHandles.setVisible(on);
  if (!on || !builder) return;
  const j = (side: ArmSide) => ({ shoulder: builder!.posedWorldJoint(side, 'shoulder'), elbow: builder!.posedWorldJoint(side, 'elbow'), wrist: builder!.posedWorldJoint(side, 'wrist') });
  jointHandles.update({ left: j('left'), right: j('right') });
  viewer.requestRender();
}

function refreshPosePanel() {
  updateJointHandles();
  if (!posePanel) return;
  const rest = builder
    ? { left: builder.restArm('left'), right: builder.restArm('right') }
    : { left: { raise: 45, forward: 0, bend: 45 }, right: { raise: 45, forward: 0, bend: 45 } };
  posePanel.update({ available: poseAvailable(), pose: builderState?.pose ?? {}, rest });
}

let poseSaveTimer = 0;
/** Pose the arms. Designs ride along with the skin; nothing is recomputed. */
function setPose(pose: Pose, live: boolean, preset?: string) {
  if (!builderState || !builder || !poseAvailable()) return;
  builderState.pose = isRestPose(pose) ? {} : pose;
  builder.setPose(builderState.pose);
  const D = display();
  for (const d of placed) d.decal.setPositions(D);
  updateGizmo();
  if (measuring) { measureOverlay.clear(); measureFirst = null; }
  viewer.requestRender();
  refreshPosePanel();
  window.clearTimeout(poseSaveTimer);
  poseSaveTimer = window.setTimeout(() => { saveBuilderState(); autosave(); updateViewBounds(); }, live ? 400 : 0);
  if (preset === 'inner') {
    const def = REGIONS.find((r) => r.id === 'forearm-inner-left');
    if (def) setTimeout(() => goTo(def), 50);
  } else if (preset && !live) viewer.frameBody(heightM());
}

function openPosePanel() {
  closeBodyPanel();
  if (!posePanel) {
    posePanel = new PosePanel(stage, { available: poseAvailable(), pose: builderState?.pose ?? {}, rest: { left: { raise: 45, forward: 0, bend: 45 }, right: { raise: 45, forward: 0, bend: 45 } } }, {
      onPose: setPose,
      onClose: closePosePanel,
    });
  }
  posePanel.show();
  refreshPosePanel();
  stage.classList.add('body-open');
  $('btn-pose').classList.add('active');
  updateViewInsets();
}

function closePosePanel() {
  posePanel?.hide();
  updateJointHandles();
  if (!bodyPanel?.open) stage.classList.remove('body-open');
  $('btn-pose').classList.remove('active');
  updateViewInsets();
}

function closeBodyPanel() {
  bodyPanel?.hide();
  if (!posePanel?.open) stage.classList.remove('body-open');
  $('btn-shape').classList.remove('active');
  updateViewInsets();
  showNavigationTip();
}

/** How to look around, said once per visit in the status line (the app should never need a manual). */
let navTipShown = false;
function showNavigationTip() {
  if (navTipShown) return;
  navTipShown = true;
  const touch = matchMedia('(pointer: coarse)').matches;
  setStatus(touch
    ? 'One finger turns the body · pinch to zoom · two fingers move it · double-tap to zoom in, double-tap the background for the whole body'
    : 'Drag to turn the body · scroll to zoom · right-drag to move · double-click to zoom in, double-click the background for the whole body');
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
  refreshPosePanel();
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

function regionPose(def: RegionDef) {
  if (!surface) return null;
  const labels = surface.labels && surface.partNames ? { labels: surface.labels, names: surface.partNames } : undefined;
  const posed = bodySource === 'builder' && builder && !isRestPose(builder.pose);
  const shownBody = posed && builder ? { positions: builder.displayPositions(), normals: builder.displayNormals() } : undefined;
  return locateRegion(def, surface.positions, heightM(), labels, shownBody);
}

function goTo(def: RegionDef) {
  if (!surface) return;
  const pose = regionPose(def);
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
type SkinHit = { tri: number; point: [number, number, number]; shown: [number, number, number] };

function pickSurface(clientX: number, clientY: number): SkinHit | null {
  if (!surface) return null;
  raycaster.setFromCamera(ndcAt(clientX, clientY), viewer.camera);
  return firstSkinHit();
}

/** The skin seen from `from` looking at `to` (world space, as displayed). */
function skinAlong(from: Vector3, to: Vector3): SkinHit | null {
  if (!surface) return null;
  raycaster.set(from, to.clone().sub(from).normalize());
  return firstSkinHit();
}

function firstSkinHit(): SkinHit | null {
  if (!surface) return null;
  const hits = raycaster.intersectObjects(viewer.bodyMeshes(), false);
  const hit = hits.find((h) => h.faceIndex !== undefined && h.faceIndex !== null);
  if (!hit) return null;
  try {
    const tri = triangleForHit(surface, hit.object as Mesh, hit.faceIndex!);
    const seen: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
    const D = display();
    if (D === surface.positions) return { tri, point: seen, shown: seen };
    // Same barycentric spot of the triangle in the rest pose.
    const I = surface.indices, P = surface.positions;
    const a = I[tri * 3] * 3, b = I[tri * 3 + 1] * 3, c = I[tri * 3 + 2] * 3;
    const ux = D[b] - D[a], uy = D[b + 1] - D[a + 1], uz = D[b + 2] - D[a + 2];
    const vx = D[c] - D[a], vy = D[c + 1] - D[a + 1], vz = D[c + 2] - D[a + 2];
    const wx = seen[0] - D[a], wy = seen[1] - D[a + 1], wz = seen[2] - D[a + 2];
    const uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz, vv = vx * vx + vy * vy + vz * vz;
    const wu = wx * ux + wy * uy + wz * uz, wv = wx * vx + wy * vy + wz * vz;
    const den = uu * vv - uv * uv || 1e-30;
    const bv = (vv * wu - uv * wv) / den, bw = (uu * wv - uv * wu) / den, bu = 1 - bv - bw;
    const point: [number, number, number] = [bu * P[a] + bv * P[b] + bw * P[c], bu * P[a + 1] + bv * P[b + 1] + bw * P[c + 1], bu * P[a + 2] + bv * P[b + 2] + bw * P[c + 2]];
    return { tri, point, shown: seen };
  } catch { return null; }
}
function pickDesign(clientX: number, clientY: number): PlacedDesign | null {
  raycaster.setFromCamera(ndcAt(clientX, clientY), viewer.camera);
  const meshes = placed.filter((d) => d.decal.mesh.visible).map((d) => d.decal.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  // A new design over an existing tattoo wins: that is the one being worked on.
  let existing: PlacedDesign | null = null;
  for (const h of hits) {
    const d = placed.find((x) => x.decal.mesh === h.object);
    if (!d || !h.uv) continue;
    const inV = h.uv.y >= 0 && h.uv.y <= 1;
    const inU = d.placement.wrap || (h.uv.x >= 0 && h.uv.x <= 1);
    if (!inV || !inU) continue;
    if (!d.placement.existing) return d;
    existing ??= d;
  }
  return existing;
}

const isLocked = (d: PlacedDesign | null) => !!d?.placement.locked;
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
  // Existing tattoos are drawn first, so new designs layer over them like new ink.
  if (placement.existing) d.decal.mesh.renderOrder = 9;
  placed.push(d);
  viewer.scene.add(d.decal.mesh);
  return d;
}

function place(entry: DesignEntry, tri: number, point: [number, number, number], extra: Partial<PlacementData> = {}): PlacedDesign | null {
  const data: PlacementData = {
    id: newId('p'), designId: entry.source.id, tri, point, normal: [0, 0, 1], rotation: 0,
    widthCm: entry.defaultWidthCm, mirror: false, wrap: false, opacity: 1, mode: 'stencil', option: 'both',
    ...extra,
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
        d.update(surface!, state.exact, display());
        if (d === selected) { panel.renderReadout(d); updateGizmo(); if (state.exact) scheduleCoverCheck(); }
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
  scheduleCoverCheck();
  if (d) revealSelected();
}

/**
 * If the design panel covers the selected design (or its handles and size
 * tag), ease the view over just enough to show it, like scrolling it into
 * view. Never while a finger or the mouse is still moving something, and
 * never when it is already in the clear, so a tap is never followed by the
 * body sliding away.
 */
let revealFrame = 0;
function revealSelected() {
  cancelAnimationFrame(revealFrame);
  let tries = 0;
  const check = () => {
    if (!selected || drag || pinchStart || ++tries > 600) return;
    if (anyBusy() || !viewer.isSettled()) { revealFrame = requestAnimationFrame(check); return; }
    keepClearOfPanel(selected);
  };
  revealFrame = requestAnimationFrame(check);
}

function keepClearOfPanel(d: PlacedDesign) {
  if (!surface || !d.result || compare || d.placement.hidden || bodyPanel?.open || posePanel?.open) return;
  const pr = panel.el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (pr.width === 0 || pr.height === 0) return;
  const pts = d.outline(surface, 0.01, display()).filter((p): p is [number, number, number] => !!p);
  const h = d.handles(surface, display());
  if (h.rotate) pts.push(h.rotate);
  if (h.scale) pts.push(h.scale);
  if (!pts.length) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { const s = toScreen(p); x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); }
  const M = 28; // handle radius and a little air
  x0 -= M; x1 += M; y0 -= M; y1 += M;
  if (!sizeTag.classList.contains('hidden')) {
    // The size tag hangs below the design and can be wider than it.
    const t = sizeTag.getBoundingClientRect();
    x0 = Math.min(x0, t.left - 8); x1 = Math.max(x1, t.right + 8); y1 = Math.max(y1, t.bottom + 8);
  }
  if (x1 <= pr.left || y1 <= pr.top || x0 >= pr.right || y0 >= pr.bottom) return; // not covered
  let dx = 0, dy = 0;
  if (pr.width < sr.width * 0.9) {
    // Side panel: move the design left into the space beside it.
    const free0 = sr.left, free1 = pr.left;
    dx = x1 - x0 <= free1 - free0 ? Math.max(free1 - x1, free0 - x0) : (free0 + free1) / 2 - (x0 + x1) / 2;
    dx = Math.min(0, dx);
  } else {
    // Bottom sheet: move the design up into the space above it.
    const free0 = sr.top, free1 = pr.top;
    dy = y1 - y0 <= free1 - free0 ? Math.max(free1 - y1, free0 - y0) : (free0 + free1) / 2 - (y0 + y1) / 2;
    dy = Math.min(0, dy);
  }
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
  const cam = viewer.camera, target = viewer.controls.target;
  const c = new Vector3(...shown(d.placement.tri, d.placement.point));
  const fwd = cam.getWorldDirection(new Vector3());
  const mpp = viewer.metresPerPixel(Math.max(0.05, c.clone().sub(cam.position).dot(fwd)));
  const right = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  // Moving the camera right slides the picture left (and up slides it down).
  const shift = right.multiplyScalar(-dx * mpp).add(up.multiplyScalar(dy * mpp));
  viewer.flyTo({ position: cam.position.clone().add(shift), target: target.clone().add(shift) }, 450);
}

function updateGizmo() {
  if (!selected || !surface || compare || !selected.result || selected.placement.hidden) { gizmo.set(null, null); return; }
  const h = selected.handles(surface, display());
  gizmo.set(selected.outline(surface, 0.004, display()), isLocked(selected) ? { rotate: null, scale: null } : h);
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
  if (doCommit && needsGeometry) revealSelected(); // a bigger design can reach under the panel
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
    const helpers = [gizmo.group, ring.group, jointHandles.group, measureOverlay.group, coverOverlay.points];
    const was = helpers.map((g) => g.visible);
    helpers.forEach((g) => { g.visible = false; });
    let blob: Blob;
    try { blob = await viewer.screenshot(); } finally { helpers.forEach((g, i) => { g.visible = was[i]; }); viewer.requestRender(); }
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
  updateJointHandles();
  viewer.requestRender();
  if (on) setStatus('Compare: left shows A, right shows B. Set each design\'s "Compare as" in its panel.');
}

// ---------- Tape measure ----------

function setMeasure(mode: null | 'distance' | 'around') {
  measuring = mode;
  measureFirst = null;
  stage.classList.toggle('measuring', !!mode);
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
    const c = circumferenceAt(surface, hit, display());
    if (!c) { $('measure-text').textContent = 'No closed loop here. Try a point on a limb.'; measureOverlay.clear(); viewer.requestRender(); return; }
    measureOverlay.set(c.points, [shown(hit.tri, hit.point)], true);
    $('measure-text').innerHTML = `Around: <b>${fmt(c.length)}</b>${c.fromShape ? '' : ' (horizontal cut)'}`;
    viewer.requestRender();
    return;
  }
  if (!measureFirst) {
    measureFirst = hit;
    measureOverlay.set([shown(hit.tri, hit.point)], [shown(hit.tri, hit.point)]);
    $('measure-text').textContent = 'Now tap the second point';
    viewer.requestRender();
    return;
  }
  const r = distanceOnSkin(surface, measureFirst, hit, display());
  if (!r) { $('measure-text').textContent = 'Too far apart for one measurement. Tap a nearer second point.'; measureFirst = null; return; }
  measureOverlay.set(r.path, [shown(measureFirst.tri, measureFirst.point), shown(hit.tri, hit.point)]);
  $('measure-text').innerHTML = `Along the skin: <b>${fmt(r.geodesic)}</b> · straight line ${fmt(r.straight)}. Tap again to start over.`;
  measureFirst = null;
  viewer.requestRender();
}

$('btn-measure').addEventListener('click', () => setMeasure(measuring ? null : 'distance'));
$('measure-done').addEventListener('click', () => setMeasure(null));
$('measure-bar').querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => b.addEventListener('click', () => setMeasure(b.dataset.measure as 'distance' | 'around')));

// ---------- Gestures ----------

type Drag = { kind: DragKind; offset: { dx: number; dy: number }; joint?: { side: ArmSide; joint: JointId; plane: Plane; start?: Partial<import('./body/pose').ArmPose> } };
let drag: Drag | null = null;
const HANDLE_RADIUS = 30;
let grabbedJoint: { side: ArmSide; joint: JointId } | null = null;
let spinSign = 1;
let lastTap: { x: number; y: number; t: number } | null = null;
let spinLast = { x: 0, y: 0 };

/** Is the pointer on the turntable ring? Returns the grabbed ring point, or null. */
function ringHit(x: number, y: number): Vector3 | null {
  let best: Vector3 | null = null, bd = 22;
  for (const p of ring.samples()) {
    const s = toScreen([p.x, p.y, p.z]);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** Joint ring under the pointer (while posing arms). */
function jointHit(x: number, y: number): { side: ArmSide; joint: JointId } | null {
  if (!jointHandles.group.visible) return null;
  let best: { side: ArmSide; joint: JointId; d: number } | null = null;
  for (const h of jointHandles.positions()) {
    const s = toScreen([h.p.x, h.p.y, h.p.z]);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < 30 && (!best || d < best.d)) best = { side: h.side, joint: h.joint, d };
  }
  return best ? { side: best.side, joint: best.joint } : null;
}

/** New pose with one arm replaced; mirrored to the other arm when both arms move together. */
function poseWithArm(side: ArmSide, arm: import('./body/pose').ArmPose): Pose {
  const cur = builderState?.pose ?? {};
  const next: Pose = { left: cur.left, right: cur.right, [side]: arm };
  if (posePanel?.side === 'both') next[side === 'left' ? 'right' : 'left'] = { ...arm };
  return next;
}

function nearHandle(x: number, y: number, p: [number, number, number] | null): boolean {
  if (!p) return false;
  const s = toScreen(p);
  return Math.hypot(s.x - x, s.y - y) < HANDLE_RADIUS;
}

attachGestures(viewer.renderer.domElement, viewer.controls, {
  hitTest(x, y) {
    const jh = jointHit(x, y);
    if (jh) { grabbedJoint = jh; return 'joint'; }
    if (!compare && surface && !measuring && selected?.result && !isLocked(selected)) {
      const h = selected.handles(surface, display());
      if (nearHandle(x, y, h.rotate)) return 'rotate';
      if (nearHandle(x, y, h.scale)) return 'scale';
    }
    const rp = ringHit(x, y);
    if (rp) {
      // Grabbing the far side of the ring turns it the other way, like a real turntable.
      const toCam = viewer.camera.position.clone().setY(0);
      spinSign = rp.clone().setY(0).dot(toCam) >= 0 ? 1 : -1;
      return 'spin';
    }
    if (compare || !surface || measuring) return null;
    if (selected?.result && !isLocked(selected)) {
      const h = selected.handles(surface, display());
      if (nearHandle(x, y, h.rotate)) return 'rotate';
      if (nearHandle(x, y, h.scale)) return 'scale';
    }
    if (pending || pickingFromScan) return null; // placing: let taps through, camera otherwise
    // Tap a design to select it; only the selected one moves when dragged.
    // Dragging anything else turns the view, so looking around never moves
    // a design by accident (the tap itself selects, see onTap).
    const d = pickDesign(x, y);
    if (d && d === selected && !isLocked(d)) return 'move';
    return null;
  },
  onTap(x, y) {
    // Double tap (or double click) on the body zooms in on that spot.
    const now = performance.now();
    const dbl = lastTap && now - lastTap.t < 350 && Math.hypot(x - lastTap.x, y - lastTap.y) < 25;
    lastTap = dbl ? null : { x, y, t: now };
    if (dbl && !pending && !pickingFromScan && !measuring && !ringHit(x, y)) {
      raycaster.setFromCamera(ndcAt(x, y), viewer.camera);
      const hit = raycaster.intersectObjects(viewer.bodyMeshes(), false)[0];
      if (hit) { viewer.zoomAt(hit.point.clone(), 0.45); return; }
      // Double tap on empty space: the whole body again, from the side you were looking at.
      const p = viewer.camera.position, t = viewer.controls.target;
      viewer.viewFrom((Math.atan2(p.x - t.x, p.z - t.z) * 180) / Math.PI, heightM());
      return;
    }
    if (measuring) { const hit = pickSurface(x, y); if (hit) measureTap(hit); return; }
    if (pickingFromScan) {
      const hit = pickSurface(x, y);
      if (!hit) { setStatus('That tap missed the body. Try again.'); return; }
      pickingFromScan = false; hint.classList.add('hidden');
      void pickUpFromScan(hit);
      return;
    }
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
    if (kind === 'spin') { spinLast = { x, y }; viewer.renderer.domElement.classList.add('grabbing'); return; }
    if (kind === 'joint' && grabbedJoint && builder) {
      // Drag in the plane through the joint that faces the camera.
      const p = builder.posedWorldJoint(grabbedJoint.side, grabbedJoint.joint);
      const n = new Vector3(); viewer.camera.getWorldDirection(n);
      // The arm as it was when grabbed: the solver moves it as little as it can
      // from there, so dragging out and back returns it as it was.
      const start = builderState?.pose?.[grabbedJoint.side];
      drag = { kind, offset: { dx: 0, dy: 0 }, joint: { ...grabbedJoint, plane: new Plane().setFromNormalAndCoplanarPoint(n, p), start: { ...(start ?? {}) } } };
      posePanel?.focusArm(grabbedJoint.side);
      return;
    }
    if (!selected || !surface) return;
    let offset = { dx: 0, dy: 0 };
    if (kind === 'move') {
      const c = toScreen(shown(selected.placement.tri, selected.placement.point));
      offset = { dx: c.x - x, dy: c.y - y };
    }
    drag = { kind, offset };
  },
  onDragMove(kind, x, y) {
    if (kind === 'spin') {
      const dx = x - spinLast.x, dy = y - spinLast.y;
      spinLast = { x, y };
      viewer.spin(-spinSign * dx * 0.009, dy * 0.006, bodyCentre());
      return;
    }
    if (kind === 'joint' && drag?.joint && builder && builderState) {
      raycaster.setFromCamera(ndcAt(x, y), viewer.camera);
      const ray = raycaster.ray;
      const t = new Vector3();
      if (drag.joint.joint === 'elbow') {
        // The elbow can only be on a sphere around the shoulder: put it where
        // the pointer ray meets that sphere (the hit nearer the current elbow),
        // or as close to the ray as it can get.
        const sh = builder.posedWorldJoint(drag.joint.side, 'shoulder');
        const el = builder.posedWorldJoint(drag.joint.side, 'elbow');
        const r = el.distanceTo(sh);
        const oc = ray.origin.clone().sub(sh);
        const bq = oc.dot(ray.direction), cq = oc.lengthSq() - r * r, disc = bq * bq - cq;
        if (disc >= 0) {
          const t1 = -bq - Math.sqrt(disc), t2 = -bq + Math.sqrt(disc);
          const p1 = ray.at(t1, new Vector3()), p2 = ray.at(t2, new Vector3());
          t.copy(p1.distanceTo(el) <= p2.distanceTo(el) ? p1 : p2);
        } else ray.closestPointToPoint(sh, t);
      } else if (!ray.intersectPlane(drag.joint.plane, t)) return;
      setPose(poseWithArm(drag.joint.side, builder.solveIK(drag.joint.side, drag.joint.joint, t, drag.joint.start)), true);
      return;
    }
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
  onPinchStart() {
    if (!selected) return;
    pinchStart = { width: selected.placement.widthCm, rotation: selected.placement.rotation };
  },
  onPinchMove(scale, rotation) {
    if (!selected || !pinchStart) return;
    const p = selected.placement;
    p.widthCm = Math.round(Math.min(150, Math.max(1, pinchStart.width * scale)) * 10) / 10;
    const r = pinchStart.rotation - rotation; // turning the fingers clockwise turns the design clockwise
    p.rotation = Math.atan2(Math.sin(r), Math.cos(r));
    panel.show(selected);
    recompute(selected, false);
  },
  onCameraZoom(factor, x, y, first) {
    // Zoom about the skin where the pinch began: drifting fingers do not pan.
    if (first || !pinchAnchor) pinchAnchor = freshZoomAnchor(x, y);
    viewer.zoomAt(pinchAnchor, factor);
  },
  onCameraPan(dx, dy) { viewer.panBy(dx, dy); },
  onCameraEnd(mode) {
    // After a pan, turn around the skin now in the middle of the view (as
    // other 3D viewers do), not around a point the pan left behind.
    if (mode !== 'pan') return;
    const s = toScreen(viewer.controls.target.toArray() as [number, number, number]);
    raycaster.setFromCamera(ndcAt(s.x, s.y), viewer.camera);
    const hit = raycaster.intersectObjects(viewer.bodyMeshes(), false)[0];
    if (hit) viewer.setPivot(hit.point);
  },
  onPinchEnd() {
    pinchStart = null;
    if (selected) { recompute(selected, true); commit(); revealSelected(); }
  },
  onDragEnd(kind, cancelled) {
    if (kind === 'spin') { viewer.renderer.domElement.classList.remove('grabbing'); return; }
    if (kind === 'joint') {
      drag = null; grabbedJoint = null;
      if (!cancelled && builderState) setPose(builderState.pose ?? {}, false);
      return;
    }
    drag = null;
    if (!selected) return;
    recompute(selected, true);
    if (!cancelled) commit();
    panel.show(selected);
    revealSelected();
  },
});
viewer.controls.addEventListener('change', () => { /* handles are sprites; nothing to do */ });

// The view buttons make way for the placement hint.
new MutationObserver(() => stage.classList.toggle('hinting', !hint.classList.contains('hidden'))).observe(hint, { attributes: true, attributeFilter: ['class'] });

// Hover feedback: grab cursor over the ring and the joint rings, ring lights up.
let ringHover = false;
viewer.renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const onRing = !!ringHit(e.clientX, e.clientY);
  const onJoint = !!jointHit(e.clientX, e.clientY);
  viewer.renderer.domElement.classList.toggle('grab', onRing || onJoint);
  if (onRing !== ringHover) {
    ringHover = onRing;
    ring.setHighlight(onRing);
    viewer.requestRender();
    if (onRing) setStatus('Drag the ring to turn the body; up and down tilts it. Double-click for the front view.');
  }
});
viewer.renderer.domElement.addEventListener('dblclick', (e) => {
  if (ringHit(e.clientX, e.clientY)) viewer.frameBody(heightM());
});
$('view-chips').querySelectorAll<HTMLButtonElement>('[data-yaw]').forEach((b) => b.addEventListener('click', () => viewer.viewFrom(Number(b.dataset.yaw), heightM())));

// ---------- Size on the body ----------

const sizeTag = document.createElement('div');
sizeTag.className = 'size-tag hidden';
stage.appendChild(sizeTag);
const sizeText = (wCm: number, hCm: number) => `${wCm.toFixed(1)} × ${hCm.toFixed(1)} cm · ${(wCm / 2.54).toFixed(1)} × ${(hCm / 2.54).toFixed(1)} in`;

/** Keep the size tag under the selected design as the view moves. */
function positionSizeTag() {
  if (!selected || !surface || !selected.result || compare || selected.placement.hidden || bodyPanel?.open || posePanel?.open) { sizeTag.classList.add('hidden'); return; }
  const H = selected.heightM;
  const p = selected.surfacePoint(surface, 0, -H / 2 - 0.006, 0.003, display());
  if (!p) { sizeTag.classList.add('hidden'); return; }
  const s = toScreen(p), r = stage.getBoundingClientRect();
  sizeTag.style.left = `${s.x - r.left}px`;
  sizeTag.style.top = `${s.y - r.top + 14}px`;
  sizeTag.textContent = sizeText(selected.placement.widthCm, selected.result.heightCm);
  sizeTag.classList.remove('hidden');
}
viewer.onAfterRender = positionSizeTag;

let pinchStart: { width: number; rotation: number } | null = null;
/** Where a two-finger camera pinch zooms to (fixed for the whole pinch). */
let pinchAnchor: Vector3 | null = null;
let resizeCommit = 0;
/** Resize the selected design by a factor, live; the exact mapping and an undo step follow when it settles. */
function resizeSelected(factor: number, settleMs = 300) {
  if (!selected) return;
  const p = selected.placement;
  p.widthCm = Math.round(Math.min(150, Math.max(1, p.widthCm * factor)) * 10) / 10;
  panel.show(selected);
  recompute(selected, false);
  window.clearTimeout(resizeCommit);
  resizeCommit = window.setTimeout(() => { if (selected) { recompute(selected, true); commit(); } }, settleMs);
}

// ---------- Stencil export ----------

const exportDialog = new ExportDialog(app);

function openExport() {
  if (!selected || !selected.result) { setStatus('Select a design first.'); return; }
  const p = selected.placement;
  const entry = designs.get(p.designId);
  if (!entry) return;
  const wMm = p.widthCm * 10, hMm = selected.result.heightCm * 10;
  exportDialog.open(p.design.name.replace(/\.[a-z0-9]+$/i, ''), wMm, hMm, (c) => void runExport(c));
}

function placementLines(d: PlacedDesign): string[] {
  const p = d.placement, r = d.result!;
  const lines = [
    `Size on the skin: ${p.widthCm.toFixed(1)} × ${r.heightCm.toFixed(1)} cm (${(p.widthCm / 2.54).toFixed(2)} × ${(r.heightCm / 2.54).toFixed(2)} in)`,
    `Area: ${surface ? describeArea(surface, p.tri, p.point, heightM()) : 'unknown'}`,
    `Centre of the design: ${(p.point[1] * 100).toFixed(0)} cm above the floor (body height ${heightCm} cm)`,
    `Rotation: ${describeRotation(p.rotation)}`,
  ];
  if (builder && bodySource === 'builder' && surface?.labels) {
    const j = builder.worldJoints();
    const side = p.point[0] >= 0 ? 'L' : 'R';
    const el = j[`lowerarm01.${side}____head`], wr = j[`wrist.${side}____head`];
    const dist = (q: number[]) => Math.hypot(q[0] - p.point[0], q[1] - p.point[1], q[2] - p.point[2]) * 100;
    const part = describeArea(surface, p.tri, p.point, heightM()).toLowerCase();
    if (part.includes('forearm') || part.includes('upper arm')) lines.push(`Distance from the centre to the elbow joint about ${dist(el).toFixed(0)} cm, to the wrist joint about ${dist(wr).toFixed(0)} cm`);
  }
  if (p.wrap && r.circumferenceM) lines.push(`Wraps around the limb: circumference here ${(r.circumferenceM * 100).toFixed(1)} cm`);
  if (p.mirror) lines.push('The design is shown mirrored on the body');
  const s = r.summary, worst = Math.max(s.worstStretch, -s.worstCompression);
  lines.push(worst > 0.05
    ? `Fit: the skin curves enough that a flat stencil would ${s.worstCompression < -0.05 ? 'wrinkle' : 'stretch'} (up to ${(worst * 100).toFixed(0)}% on ${(s.areaOverThreshold * 100).toFixed(0)}% of the design)`
    : `Fit: lies flat within ${(worst * 100).toFixed(1)}% on this spot`);
  lines.push(`Body: ${bodyLabel}`);
  return lines;
}

/**
 * Camera for the placement picture: the same viewing angle as now, but aimed
 * at the design and far enough back to show it with some body around it.
 * If the design faces away from the current view, look straight at it.
 */
function placementCamera(d: PlacedDesign): { position: Vector3; target: Vector3 } | null {
  if (!surface || !d.result) return null;
  const p = d.placement;
  const c = shown(p.tri, p.point);
  const D = display(), I = surface.indices;
  const a = I[p.tri * 3] * 3, b = I[p.tri * 3 + 1] * 3, k = I[p.tri * 3 + 2] * 3;
  const A = new Vector3(D[a], D[a + 1], D[a + 2]);
  const n = new Vector3(D[b], D[b + 1], D[b + 2]).sub(A).cross(new Vector3(D[k], D[k + 1], D[k + 2]).sub(A)).normalize();
  const target = new Vector3(...c);
  let dir = viewer.camera.position.clone().sub(viewer.controls.target).normalize(); // from the body towards the eye
  if (dir.dot(n) < 0.3) dir = n.clone();
  const size = Math.hypot(p.widthCm, d.result.heightCm) / 100;
  const frame = Math.max(0.35, size * 2.6); // metres of body visible top to bottom
  const dist = frame / 2 / Math.tan((viewer.camera.fov * Math.PI) / 360);
  return { position: target.clone().addScaledVector(dir, dist), target };
}

async function snapshotJpeg(): Promise<{ jpeg: Uint8Array; widthPx: number; heightPx: number } | undefined> {
  try {
    const helpers = [gizmo.group, ring.group, jointHandles.group, measureOverlay.group, coverOverlay.points];
    const was = helpers.map((g) => g.visible);
    helpers.forEach((g) => { g.visible = false; });
    const cam = selected ? placementCamera(selected) : null;
    let png: Blob;
    try { png = await (cam ? viewer.snapshotFrom(cam.position, cam.target) : viewer.screenshot()); } finally { helpers.forEach((g, i) => { g.visible = was[i]; }); viewer.requestRender(); }
    const bmp = await createImageBitmap(png);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#1b1d22'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0);
    const jpg = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('jpeg'))), 'image/jpeg', 0.9));
    return { jpeg: new Uint8Array(await jpg.arrayBuffer()), widthPx: c.width, heightPx: c.height };
  } catch { return undefined; }
}

/** 45 -> "45", 6.5 -> "6.5" (for file names). */
const cmName = (mm: number) => String(Math.round(mm) / 10);

async function runExport(c: ExportChoice) {
  if (!selected || !selected.result) return;
  const d = selected, p = d.placement;
  const entry = designs.get(p.designId);
  if (!entry) return;
  const wMm = p.widthCm * 10, hMm = d.result!.heightCm * 10;
  // The stencil matches what is on the skin: mirrored if the design is mirrored there, and again for transfer paper if asked.
  const mirror = p.mirror !== c.mirror;
  const base = `${entry.source.name.replace(/\.[a-z0-9]+$/i, '')}_${cmName(wMm)}x${cmName(hMm)}cm${c.mirror ? '_mirrored' : ''}`;
  exportDialog.busy(true);
  try {
    let blob: Blob, name: string;
    if (c.format === 'svg') {
      blob = new Blob([stencilSvg(entry.source, wMm, hMm, mirror)], { type: 'image/svg+xml' });
      name = `${base}.svg`;
    } else {
      const img = await sourceImage(entry.source);
      if (c.format === 'png') {
        blob = new Blob([await stencilPng(img, wMm, hMm, mirror) as BlobPart], { type: 'image/png' });
        name = `${base}_300dpi.png`;
      } else {
        const snapshot = c.placement ? await snapshotJpeg() : undefined;
        const pdf = await stencilPdf(img, { name: entry.source.name.replace(/\.[a-z0-9]+$/i, ''), widthMm: wMm, heightMm: hMm, mirror, placement: placementLines(d), snapshot }, c.paper, c.placement);
        blob = new Blob([pdf as BlobPart], { type: 'application/pdf' });
        name = `${base}_stencil.pdf`;
      }
    }
    const file = new File([blob], name, { type: blob.type });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      try { await nav.share({ files: [file], title: name }); } catch { download(blob, name); }
    } else download(blob, name);
    setStatus(`Exported ${name}`);
    exportDialog.close();
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${(err as Error).message}`);
  } finally {
    exportDialog.busy(false);
  }
}

// ---------- Zoom ----------

/**
 * The point to zoom towards: the skin under (x, y), else the orbit target's
 * depth under (x, y). Successive wheel steps at the same pointer position
 * reuse the anchor, so a quick series of steps scales exactly about that
 * spot even while the camera is still gliding.
 */
let lastAnchor: { x: number; y: number; t: number; p: Vector3 } | null = null;
function zoomAnchor(x: number, y: number): Vector3 {
  const now = performance.now();
  if (lastAnchor && now - lastAnchor.t < 500 && Math.hypot(x - lastAnchor.x, y - lastAnchor.y) < 3) {
    lastAnchor.t = now;
    return lastAnchor.p.clone();
  }
  const p = freshZoomAnchor(x, y);
  lastAnchor = { x, y, t: now, p: p.clone() };
  return p;
}
function freshZoomAnchor(x: number, y: number): Vector3 {
  raycaster.setFromCamera(ndcAt(x, y), viewer.camera);
  const hit = raycaster.intersectObjects(viewer.bodyMeshes(), false)[0];
  if (hit) return hit.point.clone();
  const n = new Vector3(); viewer.camera.getWorldDirection(n);
  const p = new Vector3();
  return raycaster.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(n, viewer.controls.target), p) ? p : viewer.controls.target.clone();
}

/** Zoom towards the centre of the view (buttons and keys). */
function zoomCentre(factor: number) {
  const r = viewer.renderer.domElement.getBoundingClientRect();
  viewer.zoomAt(zoomAnchor(r.left + r.width / 2, r.top + r.height / 2), factor);
}

// Mouse wheel, trackpad scroll and trackpad pinch (ctrlKey) zoom towards the pointer.
stage.addEventListener('wheel', (e) => {
  if ((e.target as HTMLElement).closest('.panel, .body-panel, .sheet, .view-chips, .measure-bar')) return; // let panels scroll
  e.preventDefault();
  e.stopPropagation(); // OrbitControls would zoom to its target instead
  if (e.altKey && selected && pickDesign(e.clientX, e.clientY) === selected) {
    resizeSelected(1 / wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey));
    return;
  }
  viewer.zoomAt(zoomAnchor(e.clientX, e.clientY), wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey));
}, { capture: true, passive: false });
$('view-chips').querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) => b.addEventListener('click', () => zoomCentre(b.dataset.zoom === 'in' ? 0.7 : 1 / 0.7)));

// ---------- UI wiring ----------

const panel = new Panel(stage, {
  onSelect: (id) => select(placed.find((d) => d.placement.id === id) ?? null),
  onChange: changeSelected,
  onDuplicate: duplicateSelected,
  onRemove: () => { if (selected) removeDesign(selected); },
  onExport: () => openExport(),
});
if (window.innerWidth < 700) panel.setCollapsed(true);
// Showing or expanding the design panel can cover the design: move it clear.
let panelClass = panel.el.className;
new MutationObserver(() => { if (panel.el.className !== panelClass) { panelClass = panel.el.className; revealSelected(); } }).observe(panel.el, { attributes: true, attributeFilter: ['class'] });

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

// ---------- Cover-up check ----------

const coverOverlay = new CoverOverlay();
viewer.scene.add(coverOverlay.points);
let showThrough = false;
let coverTimer = 0;
const pixelCache = new Map<string, Rgba>();

/** Pixels of a design's image (small copy, cached per design). */
function designPixels(d: PlacedDesign): Rgba {
  const key = d.placement.designId;
  const hit = pixelCache.get(key);
  if (hit) return hit;
  const img = d.placement.design.texture.image as CanvasImageSource & { width: number; height: number };
  const s = Math.min(1, 512 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const px = { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
  pixelCache.set(key, px);
  return px;
}

interface CoverState {
  newId: string; oldId: string; oldName: string;
  samples: InkSample[];
  /** Where each old sample is on the skin (rest pose), for drawing. */
  skin: Array<{ tri: number; point: [number, number, number] } | null>;
}
let cover: CoverState | null = null;

/** The existing tattoo a new design is most likely meant to cover (overlapping or close). */
function oldTattooNear(d: PlacedDesign): PlacedDesign | null {
  let best: PlacedDesign | null = null, bd = Infinity;
  const c = new Vector3(...d.placement.point);
  for (const o of placed) {
    if (!o.placement.existing || o === d || !o.result) continue;
    const dist = c.distanceTo(new Vector3(...o.placement.point));
    const reach = 0.5 * (Math.hypot(d.widthM, d.heightM) + Math.hypot(o.widthM, o.heightM)) + 0.05;
    if (dist < reach && dist < bd) { bd = dist; best = o; }
  }
  return best;
}

/** Old ink in the new design's flat coordinates, following the skin. */
function coverSamples(d: PlacedDesign, old: PlacedDesign): CoverState | null {
  if (!surface || !d.result) return null;
  const img = designPixels(old);
  const step = Math.max(0.002, Math.hypot(old.widthM, old.heightM) / 70);
  const raw = sampleInk(img, old.widthM, old.heightM, old.placement.mirror, step);
  const loc = old.getLocator(surface);
  if (!loc || !raw.length) return null;
  const skin = raw.map((s) => loc.locateTri(s.u, s.v));
  // A flattening around the new design's centre, wide enough to reach all the old ink.
  const p = d.placement;
  const anchor = new Vector3(...p.point);
  let reach = 0;
  for (const h of skin) if (h) reach = Math.max(reach, anchor.distanceTo(new Vector3(...h.point)));
  const normal = normalAt(surface, p.tri, barycentric(surface, p.tri, p.point));
  const tangent = designTangent(normal, p.rotation);
  const patch = computeExpMap(surface, { tri: p.tri, point: p.point, normal, tangent }, { radius: Math.min(0.5, reach * 1.3 + 0.03), exact: false, smoothPasses: 2 });
  const I = surface.indices;
  const samples: InkSample[] = raw.map((s, i) => {
    const h = skin[i];
    const far = { u: 1e3, v: 1e3, dark: s.dark };
    if (!h) return far;
    const l = [patch.local[I[h.tri * 3]], patch.local[I[h.tri * 3 + 1]], patch.local[I[h.tri * 3 + 2]]];
    if (l.some((x) => x < 0)) return far;
    const b = barycentric(surface!, h.tri, h.point);
    return {
      u: b[0] * patch.uv[l[0] * 2] + b[1] * patch.uv[l[1] * 2] + b[2] * patch.uv[l[2] * 2],
      v: b[0] * patch.uv[l[0] * 2 + 1] + b[1] * patch.uv[l[1] * 2 + 1] + b[2] * patch.uv[l[2] * 2 + 1],
      dark: s.dark,
    };
  });
  return { newId: p.id, oldId: old.placement.id, oldName: old.placement.design.name.replace(/(-existing)?\.[a-z0-9]+$/i, ''), samples, skin };
}

function scheduleCoverCheck() {
  clearTimeout(coverTimer);
  coverTimer = window.setTimeout(updateCoverCheck, 150);
}

/** Fill the panel's cover-up section for the selected design. */
function updateCoverCheck() {
  const el = panel.cover;
  const d = selected;
  coverOverlay.clear();
  if (!d || !surface || !d.result || compare) { el.classList.add('hidden'); cover = null; viewer.requestRender(); return; }
  if (d.placement.existing) {
    el.innerHTML = '<b>Planning a cover-up?</b> Add a new design and drag it over this tattoo: its panel then shows how much of this one it hides.';
    el.classList.remove('hidden');
    cover = null;
    return;
  }
  const old = oldTattooNear(d);
  if (!old) { el.classList.add('hidden'); cover = null; return; }
  cover = coverSamples(d, old);
  if (!cover) { el.classList.add('hidden'); return; }
  const res = coverage(cover.samples, designPixels(d), d.widthM, d.placement.design.aspect, d.placement.mirror);
  const pct = Math.round(res.covered * 100);
  const cls = res.covered >= 0.95 ? 'ok' : 'warn';
  el.innerHTML = `<b>Cover-up check</b> against <i>${cover.oldName}</i>: <span class="${cls}">hides ${pct}% of the old tattoo</span>. `
    + (res.covered >= 0.95 ? 'Its ink is at least as dark as the old ink almost everywhere.' : 'Where the new design is lighter or open, the old ink would show through.')
    + `<div class="row"><button class="btn toggle${showThrough ? ' active' : ''}" data-cover="show">Show what shows through</button><button class="btn" data-cover="size">Size to cover</button></div>`
    + '<span class="muted">An estimate from the two images: the artist decides how to shade a cover-up.</span>';
  el.classList.remove('hidden');
  if (showThrough) {
    const D = display(), pos: number[] = [];
    res.hidden.forEach((h, i) => {
      const sk = cover!.skin[i];
      if (h || !sk) return;
      const q = toDisplay(surface!, D, sk.tri, sk.point);
      const n = normalAtShown(sk.tri, D);
      pos.push(q[0] + n[0] * 0.002, q[1] + n[1] * 0.002, q[2] + n[2] * 0.002);
    });
    coverOverlay.set(pos);
  }
  viewer.requestRender();
}

function normalAtShown(tri: number, D: Float32Array): [number, number, number] {
  const I = surface!.indices;
  const a = I[tri * 3] * 3, b = I[tri * 3 + 1] * 3, c = I[tri * 3 + 2] * 3;
  const n = new Vector3(D[b] - D[a], D[b + 1] - D[a + 1], D[b + 2] - D[a + 2]).cross(new Vector3(D[c] - D[a], D[c + 1] - D[a + 1], D[c + 2] - D[a + 2])).normalize();
  const N = surface!.normals;
  if (D === surface!.positions && n.x * N[a] + n.y * N[a + 1] + n.z * N[a + 2] < 0) n.negate();
  return [n.x, n.y, n.z];
}

panel.cover.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-cover]') as HTMLElement | null;
  if (!b || !selected) return;
  if (b.dataset.cover === 'show') { showThrough = !showThrough; updateCoverCheck(); return; }
  if (b.dataset.cover === 'size' && cover) {
    const d = selected;
    const s = sizeToCover(cover.samples, designPixels(d), d.placement.design.aspect, d.placement.mirror, Math.max(0.01, d.widthM * 0.5), 1.5);
    const w = Math.round(s.widthM * 1000) / 10;
    if (s.reached) {
      changeSelected({ widthCm: w }, true);
      setStatus(`At ${w} cm wide it hides ${Math.round(s.covered * 100)}% of the old tattoo.`);
    } else setStatus(`At no size does it hide more than ${Math.round(s.covered * 100)}% (best at ${w} cm): it has light or open areas over the old ink. Try moving or turning it, or a design with more solid dark areas.`);
  }
});

// ---------- Existing tattoo from a textured scan ----------

let pickingFromScan = false;
let scanTex: { surface: SurfaceMesh; tex: ScanTexture | null } | null = null;

/** Texture coordinates and images of the loaded scan, per surface triangle (built once per scan). */
function scanTexture(): ScanTexture | null {
  if (!surface) return null;
  if (scanTex?.surface === surface) return scanTex.tex;
  const nT = surface.indices.length / 3;
  const triUv = new Float32Array(nT * 6).fill(NaN), triTex = new Uint8Array(nT);
  const textures: ScanTexture['textures'] = [];
  const seen = new Map<unknown, number>();
  const maxSide = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) ? 2048 : 4096;
  for (const src of surface.sources) {
    const g = src.mesh.geometry, uv = g.getAttribute('uv');
    const mat = (Array.isArray(src.mesh.material) ? src.mesh.material[0] : src.mesh.material) as { map?: { image?: CanvasImageSource & { width: number; height: number }; flipY: boolean } | null };
    const map = mat?.map;
    if (!uv || !map?.image) continue;
    let ti = seen.get(map);
    if (ti === undefined) {
      const im = map.image, k = Math.min(1, maxSide / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(im, 0, 0, c.width, c.height);
      ti = textures.length;
      textures.push({ img: { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data }, flipY: map.flipY });
      seen.set(map, ti);
    }
    const index = g.index;
    for (let k = 0; k < src.triCount; k++) {
      const orig = src.triStart + k, t = surface.triRemap ? surface.triRemap[orig] : orig;
      if (t < 0) continue;
      for (let c = 0; c < 3; c++) {
        const vi = index ? index.getX(k * 3 + c) : k * 3 + c;
        triUv[t * 6 + c * 2] = uv.getX(vi); triUv[t * 6 + c * 2 + 1] = uv.getY(vi);
      }
      triTex[t] = ti;
    }
  }
  scanTex = { surface, tex: textures.length ? { triUv, triTex, textures } : null };
  return scanTex.tex;
}

function startPickFromScan() {
  if (!scanTexture()) { setStatus('This body has no photo texture to pick a tattoo from. Load a textured scan (GLB, or OBJ with its MTL and images).'); return; }
  pending = null;
  pickingFromScan = true;
  hint.textContent = 'Tap the middle of the tattoo on your scan';
  hint.classList.remove('hidden');
  if (selected) select(null);
}

/**
 * Lift the tattoo around a tapped spot off the scan's photo texture: render
 * the skin flat through the stencil mapping (true size and shape), separate
 * the ink, and keep it as an existing tattoo at exactly that spot. Grows the
 * area until the ink no longer runs off its edge.
 */
async function pickUpFromScan(hit: SkinHit) {
  const tex = scanTexture();
  if (!surface || !tex) return;
  setStatus('Looking at the tattoo on your scan…');
  await new Promise((r) => setTimeout(r, 30));
  const normal = normalAt(surface, hit.tri, barycentric(surface, hit.tri, hit.point));
  const tangent = designTangent(normal, 0);
  let half = 0.06;
  for (let attempt = 0; attempt < 5; attempt++) {
    const patch = computeExpMap(surface, { tri: hit.tri, point: hit.point, normal, tangent }, { radius: half * 1.45, exact: true, smoothPasses: 3 });
    const loc = new PatchLocator(surface, patch);
    const px = Math.min(1400, Math.round(half * 2 * 8000)); // about 8 pixels per mm (less for big ones)
    const flat = renderSkin((u, v) => loc.locateTri(u, v), tex, half * 2, px);
    const ink = extractInk(flat);
    keepCentralInk(ink);
    if (!ink.bbox) { setStatus('No tattoo found there. Tap right on the ink.'); return; }
    const edge = Math.round(px * 0.02);
    const runsOff = ink.bbox.x0 <= edge || ink.bbox.y0 <= edge || ink.bbox.x1 >= px - edge || ink.bbox.y1 >= px - edge;
    if (runsOff && half < 0.3) { half *= 1.6; continue; }
    // Crop symmetrically around the tapped spot, so the design's centre is exactly there.
    const c = px / 2, m = Math.round(px * 0.02) + 2;
    const hx = Math.min(c, Math.max(c - ink.bbox.x0, ink.bbox.x1 - c) + m), hy = Math.min(c, Math.max(c - ink.bbox.y0, ink.bbox.y1 - c) + m);
    const img = crop(ink.image, Math.round(c - hx), Math.round(c - hy), Math.round(2 * hx), Math.round(2 * hy));
    const widthCm = Math.round(((2 * hx) / px) * half * 2 * 1000) / 10;
    const entry = await designs.addImage(rgbaToCanvas(img), 'tattoo-from-scan.png', widthCm);
    const d = place(entry, hit.tri, hit.point, { existing: true, mode: 'inked', rotation: 0, hidden: true });
    if (d) d.decal.mesh.visible = false;
    const hCm = Math.round(((2 * hy) / px) * half * 2 * 1000) / 10;
    setStatus(`Picked up a tattoo about ${widthCm} × ${hCm} cm. Your scan already shows it, so this copy is hidden; it is used for cover-up checks ("Hide tattoo" off shows it).`);
    return;
  }
  setStatus('That tattoo runs on further than 60 cm: pick it up in parts.');
}

// ---------- Existing tattoos ----------

const existingInput = document.createElement('input');
existingInput.type = 'file'; existingInput.accept = 'image/*'; existingInput.className = 'hidden';
app.appendChild(existingInput);
let lastExistingRegion = 'forearm-outer-left';
const existingImport = new ExistingImport(document.body, {
  regions: REGIONS,
  initialRegionId: () => lastExistingRegion,
  analyse: analyseExisting,
  place: placeExisting,
});

interface Suggestion { hint: PoseHint; spot: PartSpot; regionId?: string; text: string; rotation: number; flatPart: boolean }

/**
 * Find the person in the photo and work out where the tattoo is on the
 * body. The landmark model runs in the browser; nothing is uploaded.
 */
const detections = new WeakMap<Rgba, Awaited<ReturnType<typeof detectPose>>>();
async function analyseExisting(photo: Rgba, focus?: { x: number; y: number }): Promise<ImportAnalysis | null> {
  // Detect once per photo; a tap on the tattoo only redoes the cheap part.
  if (!detections.has(photo)) detections.set(photo, await detectPose(photo));
  const det = detections.get(photo);
  if (!det) return null;
  const mask = det.mask ?? undefined;
  const g = autoGuides(photo, mask, focus);
  // A wide shot (whole torso in view): the tattoo is a small part of it; ask for a tap rather than guess.
  const L = det.landmarks, seen = (i: number) => (L[i]?.visibility ?? 0) > 0.5;
  const torsoPx = seen(11) && seen(12) && seen(23) && seen(24) ? Math.abs((L[11].y + L[12].y) / 2 - (L[23].y + L[24].y) / 2) * photo.height : 0;
  const wide = torsoPx > photo.height * 0.15;
  // Only trust the pose when the photo really shows the body (shoulders and
  // hips clearly visible); in a close-up the model can invent a skeleton.
  if (!wide) return null;
  if (!focus) return { wide, hint: 'tap the tattoo in the photo to find where it is on the body' };
  // The tap itself is the best position of the tattoo; otherwise the ink found near the middle.
  const at = focus ?? (g.ink ? { x: (g.ink.x0 + g.ink.x1) / 2, y: (g.ink.y0 + g.ink.y1) / 2 } : { x: photo.width / 2, y: photo.height / 2 });
  const make = (mirrored: boolean): Suggestion | null => {
    const hint = suggestFromPose({ landmarks: det.landmarks, world: det.world, width: photo.width, height: photo.height, at, mirrored, mask });
    if (!hint) return null;
    const spot: PartSpot = { part: hint.part, side: hint.side, t: hint.t, u: hint.u, dir: new Vector3(...hint.surfaceDir) };
    const flatPart = hint.part === 'torso' || hint.part === 'neck' || hint.part === 'head';
    // On a flat area the photo's "up" is the design's top: turn it to match the body's up in the photo.
    const phi = Math.atan2(hint.upInPhoto.x, -hint.upInPhoto.y);
    return { hint, spot, regionId: regionForSpot(spot)?.id, text: describeHint(hint), rotation: flatPart ? (mirrored ? -phi : phi) : 0, flatPart };
  };
  const base = make(false);
  // No body part under the tattoo: the detection is not trustworthy enough to steer the guides.
  if (!base) return { hint: 'found a person, but not which part the tattoo is on. Tap the tattoo in the photo, or choose the place below' };
  const a: ImportAnalysis = {
    wide,
    kind: base.flatPart ? 'flat' : 'limb',
    regionId: base.regionId,
    hint: base.text,
    rotation: base.rotation,
    personMask: mask,
    place: { make },
    pxPerCm: base.hint.pxPerHeight ? base.hint.pxPerHeight / (heightM() * 100) : undefined,
    refine: (m) => { const r = make(m); return r ? { hint: r.text, regionId: r.regionId } : null; },
  };
  // Limb guides along the detected segment (body end first), edges from the person mask.
  const seg = base.hint.segment;
  if (!base.flatPart && seg) {
    const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) || 1;
    const u = { x: (seg.b.x - seg.a.x) / len, y: (seg.b.y - seg.a.y) / len }, across = { x: u.y, y: -u.x };
    let s0 = Infinity, s1 = -Infinity;
    const box = g.ink ?? { x0: at.x - len * 0.15, y0: at.y - len * 0.15, x1: at.x + len * 0.15, y1: at.y + len * 0.15 };
    for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]) {
      const sv = (x - seg.a.x) * u.x + (y - seg.a.y) * u.y;
      s0 = Math.min(s0, sv); s1 = Math.max(s1, sv);
    }
    const pad = (s1 - s0) * 0.12 + 4;
    s0 -= pad; s1 += pad;
    if (focus) {
      // Keep the guides on this limb around the tap (the ink box can catch a hand or a crease).
      const sf = (focus.x - seg.a.x) * u.x + (focus.y - seg.a.y) * u.y;
      s0 = Math.max(s0, sf - 0.25 * len); s1 = Math.min(s1, sf + 0.25 * len);
      if (s1 - s0 < 0.1 * len) { s0 = sf - 0.12 * len; s1 = sf + 0.12 * len; }
    }
    // Typical half-width for this part; the person mask is used when it agrees
    // (it runs on into the body where a limb lies against it).
    const expectHW = (HALF_WIDTH[base.hint.part] ?? 0.2) * len;
    const edgesAt = (sv: number): [{ x: number; y: number }, { x: number; y: number }] => {
      const c = { x: seg.a.x + u.x * sv, y: seg.a.y + u.y * sv };
      const e = maskEdges(mask, photo.width, photo.height, c, across);
      if (e) {
        const hw = Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y) / 2;
        if (hw > 0.6 * expectHW && hw < 1.6 * expectHW) return e;
      }
      return [{ x: c.x - across.x * expectHW, y: c.y - across.y * expectHW }, { x: c.x + across.x * expectHW, y: c.y + across.y * expectHW }];
    };
    const [p0, q0] = edgesAt(s0), [p1, q1] = edgesAt(s1);
    a.limb = { p0, q0, p1, q1, from: 0, to: 1 };
  }
  return a;
}
existingInput.addEventListener('change', () => { const f = existingInput.files?.[0]; existingInput.value = ''; if (f) void existingImport.open(f); });

/**
 * Rotation that points the design's top along the limb towards the body
 * (where the photo's "body end" was), at a spot on the rest-pose surface.
 */
function rotationTowardsBody(tri: number, point: [number, number, number], axis: [number, number, number], pointsToTrunk = false): number {
  if (!surface) return 0;
  const I = surface.indices, P = surface.positions;
  const a = I[tri * 3] * 3, b = I[tri * 3 + 1] * 3, c = I[tri * 3 + 2] * 3;
  const n = new Vector3(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]).cross(new Vector3(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2])).normalize();
  const N = surface.normals;
  if (n.dot(new Vector3(N[I[tri * 3] * 3], N[I[tri * 3] * 3 + 1], N[I[tri * 3] * 3 + 2])) < 0) n.negate();
  const want = new Vector3(...axis);
  const toBody = new Vector3(0, heightM() * 0.55, 0).sub(new Vector3(...point));
  if (!pointsToTrunk && want.dot(toBody) < 0) want.negate();
  want.addScaledVector(n, -want.dot(n));
  if (want.lengthSq() < 1e-8) return 0;
  want.normalize();
  const up = new Vector3(...tangentFrom([n.x, n.y, n.z], [0, 1, 0]));
  return Math.atan2(new Vector3().crossVectors(up, want).dot(n), up.dot(want));
}

/**
 * Direction of the whole body part under a triangle (bodies with part
 * labels): steadier than the local shape near a joint, where the limb bends.
 */
function partAxisAt(tri: number): [number, number, number] | null {
  if (!surface?.labels || !surface.partNames) return null;
  const label = surface.labels[surface.indices[tri * 3]];
  const name = surface.partNames[label] ?? '';
  if (!/arm|thigh|shin|hand|foot/.test(name)) return null;
  const sel: number[] = [];
  for (let v = 0; v < surface.labels.length; v++) if (surface.labels[v] === label) sel.push(v);
  if (sel.length <= 20) return null;
  const P = surface.positions, { c, d } = limbAxis(P, sel);
  // Point it at the end nearer the trunk: for arms the end nearer the body's
  // centre line, for legs the higher end (as the region finder does).
  let lo = Infinity, hi = -Infinity;
  for (const v of sel) { const t = (P[v * 3] - c[0]) * d[0] + (P[v * 3 + 1] - c[1]) * d[1] + (P[v * 3 + 2] - c[2]) * d[2]; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  const end = (t: number) => [c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t];
  const A = end(lo), B = end(hi);
  const proxIsLo = Math.abs(A[0]) - A[1] * 0.5 < Math.abs(B[0]) - B[1] * 0.5;
  return proxIsLo ? [-d[0], -d[1], -d[2]] : d;
}

/** Outward face normal of a rest-pose triangle. */
function normalAtHit(tri: number): [number, number, number] {
  if (!surface) return [0, 0, 1];
  const I = surface.indices, P = surface.positions, N = surface.normals;
  const a = I[tri * 3] * 3, b = I[tri * 3 + 1] * 3, c = I[tri * 3 + 2] * 3;
  const n = new Vector3(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]).cross(new Vector3(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2])).normalize();
  if (n.x * N[a] + n.y * N[a + 1] + n.z * N[a + 2] < 0) n.negate();
  return [n.x, n.y, n.z];
}

async function placeExisting(r: ImportResult): Promise<string | null> {
  if (!surface) return 'The body is still loading. Try again in a moment.';
  const def = REGIONS.find((x) => x.id === r.regionId);
  // The spot suggested from the photo, unless the person chose another part.
  const sugg = (r.place as { make(m: boolean): Suggestion | null } | undefined)?.make(r.mirrored) ?? null;
  const useSpot = sugg && (!r.suggestedRegionId || r.regionId === r.suggestedRegionId);
  let pose = null;
  if (useSpot && surface.labels && surface.partNames) {
    const posed = bodySource === 'builder' && builder && !isRestPose(builder.pose);
    const shownBody = posed && builder ? { positions: builder.displayPositions(), normals: builder.displayNormals() } : undefined;
    pose = locatePartSpot(sugg.spot, surface.positions, heightM(), { labels: surface.labels, names: surface.partNames }, shownBody);
  }
  pose ??= def ? regionPose(def) : null;
  if (!pose) return 'Could not find that part of this body. Pick another place.';
  const hit = skinAlong(pose.position, pose.target);
  if (!hit) return 'Could not find that part of this body. Pick another place.';
  // A measured width is the ink's own width; the image has a small margin around it.
  let width = r.widthCm ? r.widthCm * (r.flattened.widthPhotoPx / r.flattened.inkWidthPhotoPx) : null, how = 'from your measurement';
  let rotation = useSpot && sugg ? sugg.rotation : r.rotation;
  if (r.kind === 'limb') {
    // Cross-section of the limb at the spot (rest pose, like the anchor).
    const c = circumferenceAt(surface, hit);
    if (c) {
      if (!width) {
        // The limb's width across, seen from the side the photo was taken
        // from (the suggested direction, or straight at the skin there).
        const ax = new Vector3(...c.axis);
        const look = useSpot && sugg ? sugg.spot.dir.clone() : new Vector3(...normalAtHit(hit.tri));
        const across = new Vector3().crossVectors(ax, look);
        if (across.lengthSq() > 1e-8) {
          across.normalize();
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < c.points.length; i += 3) { const d = c.points[i] * across.x + c.points[i + 1] * across.y + c.points[i + 2] * across.z; lo = Math.min(lo, d); hi = Math.max(hi, d); }
          width = widthFromVisibleWidth(r.flattened, (hi - lo) * 100);
        }
        width ??= widthFromCircumference(r.flattened, c.length * 100);
        how = 'worked out from the width of the limb';
      }
      const toTrunk = partAxisAt(hit.tri);
      rotation = toTrunk ? rotationTowardsBody(hit.tri, hit.point, toTrunk, true) : rotationTowardsBody(hit.tri, hit.point, c.axis);
    }
  }
  if (!width && r.estimateCm) { width = r.estimateCm; how = 'estimated roughly from body proportions in the photo'; }
  if (!width) { width = 10; how = 'a starting guess'; }
  width = Math.round(Math.min(150, Math.max(1, width)) * 10) / 10;
  const entry = await designs.addImage(r.canvas, r.name, width);
  lastExistingRegion = r.regionId;
  pending = null; hint.classList.add('hidden');
  const d = place(entry, hit.tri, hit.point, { existing: true, mode: 'inked', rotation });
  if (!d) return 'Could not place it. Try again.';
  viewer.flyTo(pose);
  setStatus(`Existing tattoo placed, ${width} cm wide (${how}). Drag it to where it really is, match its size, then lock it.`);
  return null;
}

$('btn-add').addEventListener('click', () => addSheet.open([
  { label: 'From a file', hint: 'SVG or PNG', onClick: () => designInput.click() },
  { label: 'Test pattern', hint: '10 cm grid with a 6 cm circle', onClick: () => void designs.addTestPattern().then(startPlacing) },
  { label: 'Existing tattoo from a photo', hint: 'flatten a photo of a tattoo you already have and put it on the body', onClick: () => existingInput.click() },
  ...(scanObject && scanInfo.textured ? [{ label: 'Existing tattoo from my scan', hint: 'tap a tattoo that is in your textured scan to pick it up exactly', onClick: startPickFromScan }] : []),
  ...[...designs.entries.values()].filter((e) => e.source.name !== 'test-pattern.svg').map((e) => ({ label: `Place again: ${e.source.name}`, onClick: () => startPlacing(e) })),
]));
$('btn-parts').addEventListener('click', picker.open);
$('btn-shape').addEventListener('click', () => (bodyPanel?.open ? closeBodyPanel() : openBodyPanel()));
$('btn-pose').addEventListener('click', () => (posePanel?.open ? closePosePanel() : openPosePanel()));
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
  else if (!mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomCentre(0.7); }
  else if (!mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomCentre(1 / 0.7); }
  else if (!mod && e.key === '0') { e.preventDefault(); viewer.frameBody(heightM()); }
  else if (!selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const step = (e.shiftKey ? 45 : 15) * Math.PI / 180;
    if (e.key === 'ArrowLeft') viewer.spin(-step, 0, bodyCentre());
    else if (e.key === 'ArrowRight') viewer.spin(step, 0, bodyCentre());
    else viewer.spin(0, (e.key === 'ArrowUp' ? -1 : 1) * step * 0.66, bodyCentre());
  }
  else if (e.key === 'Escape') { if (measuring) setMeasure(null); else if (pending) { pending = null; hint.classList.add('hidden'); } else select(null); }
  else if (selected && surface && !isLocked(selected) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '[', ']'].includes(e.key)) {
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
  handles: () => (selected && surface ? selected.handles(surface, display()) : null),
  shownPoint: (tri: number, p: [number, number, number]) => shown(tri, p),
  toScreen,
  history: () => ({ canUndo: history.canUndo, canRedo: history.canRedo }),
  undo, redo, setCompare,
  orient: () => orient, changeOrientation, status: () => status.textContent,
  setMeasure, measureTap, pickSurface, measureText: () => $('measure-text').textContent,
  openBodyPanel, closeBodyPanel, choosePreset: (id: string) => { const p = presetById(id); if (p) choosePreset(p); },
  setBuilderParams, builderState: () => builderState, bodySource: () => bodySource,
  setPose, openPosePanel, closePosePanel,
  ringScreen: (deg: number) => { const r = ring.samples(360)[Math.round(((deg % 360) + 360) % 360)]; return toScreen([r.x, r.y, r.z]); },
  cameraYaw: () => Math.atan2(viewer.camera.position.x, viewer.camera.position.z) * 180 / Math.PI,
  cameraElevation: () => { const o = viewer.camera.position.clone().sub(bodyCentre()); return Math.asin(o.y / o.length()) * 180 / Math.PI; },
  viewFrom: (yaw: number) => viewer.viewFrom(yaw, heightM()),
  zoomDistance: () => viewer.zoomDistance(),
  deselect: () => select(null),
  /**
   * The forearm's true outline around a placed design as seen now, as limb
   * guides in canvas pixels (elbow end first): what a person would drag the
   * editor's handles to.
   */
  trueForearmGuides: (id: string, side: ArmSide, halfLenPx: number) => {
    const d = placed.find((x) => x.placement.id === id);
    if (!d || !surface || !builder) return null;
    const c = circumferenceAt(surface, d.placement, display());
    if (!c) return null;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const scr = (p: number[]) => { const s = toScreen([p[0], p[1], p[2]]); return { x: s.x - rect.left, y: s.y - rect.top }; };
    const e = scr(builder.posedWorldJoint(side, 'elbow').toArray()), w = scr(builder.posedWorldJoint(side, 'wrist').toArray());
    const ul = Math.hypot(w.x - e.x, w.y - e.y) || 1, u = { x: (w.x - e.x) / ul, y: (w.y - e.y) / ul }, v = { x: u.y, y: -u.x };
    let lo = Infinity, hi = -Infinity, loP = { x: 0, y: 0 }, hiP = { x: 0, y: 0 };
    for (let i = 0; i < c.points.length; i += 3) {
      const p = scr([c.points[i], c.points[i + 1], c.points[i + 2]]), t = p.x * v.x + p.y * v.y;
      if (t < lo) { lo = t; loP = p; } if (t > hi) { hi = t; hiP = p; }
    }
    const mv = (p: { x: number; y: number }, k: number) => ({ x: p.x + u.x * k, y: p.y + u.y * k });
    return { p0: mv(loP, -halfLenPx), p1: mv(loP, halfLenPx), q0: mv(hiP, -halfLenPx), q1: mv(hiP, halfLenPx) };
  },
  /** Ink area (cm²), and the 3D point of the red ink's centre, of a placed design (for checking imports). */
  inkStats: (id?: string) => {
    const d = id ? placed.find((x) => x.placement.id === id) : selected;
    if (!d || !surface || !d.result) return null;
    const img = d.placement.design.texture.image as HTMLCanvasElement | ImageBitmap;
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(img as CanvasImageSource, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let ink = 0, rx = 0, ry = 0, rn = 0, sa = 0, sx = 0, sy = 0;
    const W = d.widthM, H = d.heightM, cmx = (W * 100) / c.width, cmy = (H * 100) / c.height;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4, a = px[i + 3] / 255;
      if (px[i + 3] > 127) ink++;
      sa += a; sx += a * x * cmx; sy += a * y * cmy;
      if (px[i + 3] > 127 && px[i] > 2 * px[i + 1] && px[i] > 60) { rx += x + 0.5; ry += y + 0.5; rn++; }
    }
    // Spread of the ink around its centre (cm), weighted by ink strength: a size measure that
    // does not depend on rotation or on how dark the ink came out.
    const mx = sx / (sa || 1), my = sy / (sa || 1);
    let sr = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const a = px[(y * c.width + x) * 4 + 3] / 255;
      if (a > 0) sr += a * ((x * cmx - mx) ** 2 + (y * cmy - my) ** 2);
    }
    const spread = Math.sqrt(sr / (sa || 1));
    const area = (ink / (c.width * c.height)) * W * H * 1e4;
    let red: number[] | null = null;
    if (rn) {
      let u = (rx / rn / c.width - 0.5) * W; const v = (0.5 - ry / rn / c.height) * H;
      if (d.placement.mirror) u = -u;
      red = d.surfacePoint(surface, u, v, 0, display());
    }
    const p = d.placement;
    // The ink's own centre on the skin (not the image's: a margin or stray marks shift that).
    let cu = mx / 100 - W / 2; const cv = H / 2 - my / 100;
    if (p.mirror) cu = -cu;
    const inkCentre = d.surfacePoint(surface, cu, cv, 0, display()) ?? shown(p.tri, p.point);
    return { area, spread, red, centre: inkCentre, anchor: shown(p.tri, p.point), widthCm: p.widthCm, heightCm: d.result.heightCm, id: p.id };
  },
  /** Where the body should appear on screen (projected vertices), in page pixels. */
  bodyScreenBox: () => {
    const D = display();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < D.length; i += 3 * 7) {
      const s = toScreen([D[i], D[i + 1], D[i + 2]]);
      x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
    }
    return { x0, y0, x1, y1 };
  },
  /** Where skin-coloured pixels actually are in the rendered picture, in page pixels. */
  renderedSkinBox: async () => {
    const blob = await viewer.screenshot();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const rect = viewer.renderer.domElement.getBoundingClientRect(), k = rect.width / c.width;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4;
      if (px[i] > 110 && px[i] > px[i + 2] + 35 && px[i + 1] > 60) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    return { x0: rect.left + x0 * k, y0: rect.top + y0 * k, x1: rect.left + x1 * k, y1: rect.top + y1 * k, pixelRatio: 1 / k };
  },
  cameraState: () => ({ pos: viewer.camera.position.toArray(), target: viewer.controls.target.toArray(), height: heightM() }),
  cameraDir: () => { const v = new Vector3(); viewer.camera.getWorldDirection(v); return [v.x, v.y, v.z]; },
  lookAt: (pos: number[], target: number[]) => viewer.flyTo({ position: new Vector3(pos[0], pos[1], pos[2]), target: new Vector3(target[0], target[1], target[2]) }, 1),
  /** The view as a JPEG data URL without handles, ring or overlays (a stand-in for a phone photo). */
  photoDataUrl: async () => {
    const helpers = [gizmo.group, ring.group, jointHandles.group, measureOverlay.group, coverOverlay.points];
    const was = helpers.map((g) => g.visible);
    helpers.forEach((g) => { g.visible = false; });
    try {
      const blob = await viewer.screenshot('image/jpeg');
      return await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(blob); });
    } finally { helpers.forEach((g, i) => { g.visible = was[i]; }); viewer.requestRender(); }
  },
  openExistingPhoto: async (dataUrl: string, name = 'photo.jpg', fPx?: number) => {
    const blob = await (await fetch(dataUrl)).blob();
    if (!fPx) { await existingImport.open(new File([blob], name, { type: blob.type })); return; }
    const { loadPhoto } = await import('./ui/existingImport');
    await existingImport.openImage(await loadPhoto(blob), name.replace(/\.[a-z0-9]+$/i, ''), fPx);
  },
  /** Focal length of the view camera in canvas pixels (what a photo of the view was taken with). */
  cameraFocalPx: () => (viewer.size().height * viewer.renderer.getPixelRatio()) / 2 / Math.tan((viewer.camera.fov * Math.PI) / 360),
  existingImport,
  coverText: () => (panel.cover.classList.contains('hidden') ? null : panel.cover.textContent),
  openExport, runExport, sizeTagText: () => (sizeTag.classList.contains('hidden') ? null : sizeTag.textContent), placementLines: () => (selected ? placementLines(selected) : null),
  zoomSettled: () => viewer.isSettled(),
  cameraDistanceTo: (p: number[]) => viewer.camera.position.distanceTo(new Vector3(p[0], p[1], p[2])),
  pickAt: (x: number, y: number) => { const h = pickSurface(x, y); return h ? h.shown : null; },
  jointScreen: (side: ArmSide, joint: JointId) => { if (!builder) return null; const p = builder.posedWorldJoint(side, joint); return toScreen([p.x, p.y, p.z]); },
  posedJoint: (side: ArmSide, joint: JointId | 'shoulder') => builder ? builder.posedWorldJoint(side, joint).toArray() : null,
  setSkinMix: (m: number) => { if (builder) { builder.skinMix = m; builder.setPose(builder.pose); const D = display(); for (const d of placed) d.decal.setPositions(D); viewer.requestRender(); } },
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
