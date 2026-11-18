// Body builder: blends MakeHuman morph targets in the browser so a realistic
// body can be shaped with sliders. Topology never changes (MakeHuman hm08
// skin + eyes, subdivided once), so tattoos keep their exact spot on the
// skin while the body is reshaped.
//
// The blending rules mirror tools/body-builder/build_presets.py, which also
// calibrated the six presets.

import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three';
import { applyStencil, buildCatmullClark, quadsToTriangles, type Stencil } from '../mesh/subdivide';
import { computeNormals } from '../mesh/marchingCubes';

export const BUILDER_TOPOLOGY = 'makehuman-hm08-body+eyes/cc1';
const DENSITY = 1010; // kg/m^3

export interface BodyMeta {
  version: number;
  topology: string;
  vertexCount: number;
  quadCount: number;
  parts: string[];
  materials: string[];
  deltaUnitM: number;
  buffers: { base: number; quads: number; labels: number; material: number; bodyQuad: number };
  targets: Record<string, { count: number; index: number; delta: number }>;
  detailTargets: Record<string, string[]>;
  presets: PresetMeta[];
  source: string;
  license: string;
  rawByteLength: number;
}

export interface PresetMeta {
  id: string;
  name: string;
  sex: 'female' | 'male';
  build: 'thin' | 'athletic' | 'overweight';
  params: { gender: number; muscle: number; weight: number; breastSize: number; breastFirmness: number };
  referenceHeightCm: number;
  bmiAtReferenceHeight: number;
}

export interface BodyData {
  meta: BodyMeta;
  base: Float32Array;
  quads: Uint16Array;
  labels: Uint8Array;
  material: Uint8Array;
  bodyQuad: Uint8Array;
  targets: Map<string, { index: Uint16Array; delta: Int16Array }>;
}

export type DetailId =
  | 'shoulders' | 'chestMuscle' | 'bust' | 'waist' | 'belly' | 'hips' | 'buttocks' | 'vshape' | 'torsoLength' | 'neck'
  | 'upperArmSize' | 'upperArmMuscle' | 'forearmSize' | 'forearmMuscle' | 'armLength'
  | 'thighSize' | 'thighMuscle' | 'calfSize' | 'calfMuscle' | 'legLength';

export interface BodyParams {
  gender: number; // 0 female .. 1 male
  muscle: number; // 0..1 (MakeHuman: low = soft, high = toned)
  weight: number; // 0..1
  breastSize: number; // 0..1
  breastFirmness: number; // 0..1
  african: number; asian: number; european: number; // ancestry mix, normalised when applied
  details: Partial<Record<DetailId, number>>; // -1..1
}

export interface SliderDef {
  id: keyof BodyParams | DetailId;
  label: string;
  group: 'Basics' | 'Torso' | 'Arms' | 'Legs' | 'Ancestry';
  min: number; max: number; step: number;
  left?: string; right?: string;
  detail?: boolean;
}

export const SLIDERS: SliderDef[] = [
  { id: 'gender', label: 'Sex', group: 'Basics', min: 0, max: 1, step: 0.01, left: 'Female', right: 'Male' },
  { id: 'weight', label: 'Weight', group: 'Basics', min: 0, max: 1, step: 0.01, left: 'Light', right: 'Heavy' },
  { id: 'muscle', label: 'Muscle tone', group: 'Basics', min: 0, max: 1, step: 0.01, left: 'Soft', right: 'Toned' },
  { id: 'breastSize', label: 'Breast size', group: 'Basics', min: 0, max: 1, step: 0.01, left: 'Small', right: 'Large' },
  { id: 'breastFirmness', label: 'Breast firmness', group: 'Basics', min: 0, max: 1, step: 0.01, left: 'Soft', right: 'Firm' },
  { id: 'shoulders', label: 'Shoulder width', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'chestMuscle', label: 'Chest muscles', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'bust', label: 'Chest size', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'vshape', label: 'V-shape', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'waist', label: 'Waist', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'belly', label: 'Belly', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'hips', label: 'Hips', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'buttocks', label: 'Buttocks', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'torsoLength', label: 'Torso length', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'neck', label: 'Neck', group: 'Torso', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'upperArmSize', label: 'Upper arm size', group: 'Arms', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'upperArmMuscle', label: 'Biceps and triceps', group: 'Arms', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'forearmSize', label: 'Forearm size', group: 'Arms', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'forearmMuscle', label: 'Forearm muscle', group: 'Arms', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'armLength', label: 'Arm length', group: 'Arms', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'thighSize', label: 'Thigh size', group: 'Legs', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'thighMuscle', label: 'Thigh muscle', group: 'Legs', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'calfSize', label: 'Calf size', group: 'Legs', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'calfMuscle', label: 'Calf muscle', group: 'Legs', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'legLength', label: 'Leg length', group: 'Legs', min: -1, max: 1, step: 0.02, detail: true },
  { id: 'african', label: 'African', group: 'Ancestry', min: 0, max: 1, step: 0.01 },
  { id: 'asian', label: 'Asian', group: 'Ancestry', min: 0, max: 1, step: 0.01 },
  { id: 'european', label: 'European', group: 'Ancestry', min: 0, max: 1, step: 0.01 },
];

export const SKIN_TONES = ['#f3d6c4', '#e8bea0', '#d8a582', '#c58c66', '#a8704c', '#8a5638', '#6b4029', '#4a2c1d'];

export function defaultParams(): BodyParams {
  return { gender: 0.5, muscle: 0.5, weight: 0.5, breastSize: 0.5, breastFirmness: 0.5, african: 1 / 3, asian: 1 / 3, european: 1 / 3, details: {} };
}

export function presetParams(p: PresetMeta): BodyParams {
  return { ...defaultParams(), ...p.params, details: {} };
}

// ---------- data loading ----------

export function parseBodyData(meta: BodyMeta, raw: ArrayBuffer): BodyData {
  const b = meta.buffers;
  const n = meta.vertexCount, q = meta.quadCount;
  const targets = new Map<string, { index: Uint16Array; delta: Int16Array }>();
  for (const [name, t] of Object.entries(meta.targets)) {
    targets.set(name, { index: new Uint16Array(raw, t.index, t.count), delta: new Int16Array(raw, t.delta, t.count * 3) });
  }
  return {
    meta,
    base: new Float32Array(raw, b.base, n * 3),
    quads: new Uint16Array(raw, b.quads, q * 4),
    labels: new Uint8Array(raw, b.labels, n),
    material: new Uint8Array(raw, b.material, n),
    bodyQuad: new Uint8Array(raw, b.bodyQuad, q),
    targets,
  };
}

export async function loadBodyData(baseUrl: string): Promise<BodyData> {
  const meta = (await (await fetch(`${baseUrl}bodies/makehuman.json`)).json()) as BodyMeta;
  const res = await fetch(`${baseUrl}bodies/makehuman.bin.z`);
  if (!res.ok || !res.body) throw new Error(`could not load body data (${res.status})`);
  const stream = res.body.pipeThrough(new DecompressionStream('deflate'));
  const raw = await new Response(stream).arrayBuffer();
  if (raw.byteLength !== meta.rawByteLength) throw new Error('body data is incomplete');
  return parseBodyData(meta, raw);
}

// ---------- blending ----------

function threeWay(v: number, lo: string, mid: string, hi: string): Record<string, number> {
  v = Math.min(1, Math.max(0, v));
  return v < 0.5 ? { [lo]: 1 - v / 0.5, [mid]: v / 0.5 } : { [mid]: 1 - (v - 0.5) / 0.5, [hi]: (v - 0.5) / 0.5 };
}

/** (target, weight) pairs for the given parameters. Mirrors macro_targets() in the generator. */
export function targetWeights(p: BodyParams, detailTargets: Record<string, string[]>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const genders: Record<string, number> = { female: 1 - p.gender, male: p.gender };
  let ra = Math.max(0, p.african), rs = Math.max(0, p.asian), re = Math.max(0, p.european);
  const sum = ra + rs + re;
  if (sum <= 1e-9) { ra = rs = re = 1 / 3; } else { ra /= sum; rs /= sum; re /= sum; }
  const races: Record<string, number> = { african: ra, asian: rs, caucasian: re };
  const mus = threeWay(p.muscle, 'minmuscle', 'averagemuscle', 'maxmuscle');
  const wei = threeWay(p.weight, 'minweight', 'averageweight', 'maxweight');
  const cups = threeWay(p.breastSize, 'mincup', 'averagecup', 'maxcup');
  const firms = threeWay(p.breastFirmness, 'minfirmness', 'averagefirmness', 'maxfirmness');
  for (const [g, gw] of Object.entries(genders)) {
    if (gw <= 0) continue;
    for (const [r, rw] of Object.entries(races)) out.push([`macrodetails/${r}-${g}-young`, gw * rw]);
    for (const [m, mw] of Object.entries(mus)) {
      for (const [w, ww] of Object.entries(wei)) {
        out.push([`macrodetails/universal-${g}-young-${m}-${w}`, gw * mw * ww]);
        for (const [c, cw] of Object.entries(cups)) {
          for (const [f, fw] of Object.entries(firms)) out.push([`breast/${g}-young-${m}-${w}-${c}-${f}`, gw * mw * ww * cw * fw]);
        }
      }
    }
  }
  for (const [id, v] of Object.entries(p.details)) {
    if (!v) continue;
    for (const stem of detailTargets[id] ?? []) out.push([`${stem}-${v < 0 ? 'decr' : 'incr'}`, Math.min(1, Math.abs(v))]);
  }
  return out.filter(([, w]) => w > 1e-9);
}

/** Coarse vertex positions in metres, feet at y = 0, centred on x and z (native MakeHuman height). */
export function blendCoarse(data: BodyData, p: BodyParams, out?: Float32Array): Float32Array {
  const pos = out ?? new Float32Array(data.base.length);
  pos.set(data.base);
  const unit = data.meta.deltaUnitM;
  for (const [name, w] of targetWeights(p, data.meta.detailTargets)) {
    const t = data.targets.get(name);
    if (!t) continue;
    const s = w * unit, idx = t.index, d = t.delta;
    for (let k = 0; k < idx.length; k++) {
      const o = idx[k] * 3;
      pos[o] += s * d[k * 3]; pos[o + 1] += s * d[k * 3 + 1]; pos[o + 2] += s * d[k * 3 + 2];
    }
  }
  normalise(pos, 1);
  return pos;
}

/** Feet at y = 0, centred on x/z, scaled so the height equals `height` (or unscaled when height is 1 and native). */
function normalise(pos: Float32Array, scaleTo: number | null): void {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const s = scaleTo === null || scaleTo === 1 ? 1 : scaleTo / (maxY - minY);
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - cx) * s; pos[i + 1] = (pos[i + 1] - minY) * s; pos[i + 2] = (pos[i + 2] - cz) * s;
  }
}

/** Estimated BMI of the coarse body when scaled to `heightM`, from its volume. */
export function estimateBmi(data: BodyData, coarse: Float32Array, heightM: number): { bmi: number; massKg: number } {
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < coarse.length; i += 3) { if (coarse[i] < minY) minY = coarse[i]; if (coarse[i] > maxY) maxY = coarse[i]; }
  const s = heightM / (maxY - minY);
  const Q = data.quads, P = coarse;
  let vol = 0;
  const tri = (a: number, b: number, c: number) => {
    a *= 3; b *= 3; c *= 3;
    vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  };
  for (let f = 0; f < data.meta.quadCount; f++) {
    if (!data.bodyQuad[f]) continue;
    tri(Q[f * 4], Q[f * 4 + 1], Q[f * 4 + 2]); tri(Q[f * 4], Q[f * 4 + 2], Q[f * 4 + 3]);
  }
  const massKg = DENSITY * Math.abs(vol) * s * s * s;
  return { bmi: massKg / (heightM * heightM), massKg };
}

/**
 * Weight slider value that gives `targetBmi` at `heightM` with everything else
 * fixed. Presets are defined by BMI, so a "slightly overweight" body stays
 * slightly overweight at any height. Clamped to the slider's range.
 */
export function calibrateWeight(data: BodyData, params: BodyParams, targetBmi: number, heightM: number): number {
  const buf = new Float32Array(data.base.length);
  const bmiAt = (w: number) => estimateBmi(data, blendCoarse(data, { ...params, weight: w }, buf), heightM).bmi;
  if (bmiAt(0) >= targetBmi) return 0;
  if (bmiAt(1) <= targetBmi) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) / 2;
    if (bmiAt(m) < targetBmi) lo = m; else hi = m;
  }
  return Math.round(((lo + hi) / 2) * 1e4) / 1e4;
}

/** Preset parameters with the weight calibrated for the given height. */
export function presetParamsAtHeight(data: BodyData, preset: PresetMeta, heightM: number): BodyParams {
  const p = presetParams(preset);
  p.weight = calibrateWeight(data, p, preset.bmiAtReferenceHeight, heightM);
  return p;
}

// ---------- three.js body ----------

export interface Appearance { skinTone: string }

const EYE = { sclera: '#ece8e2', iris: '#4b3a2b', pupil: '#0e0e10' };

export class BuilderBody {
  readonly mesh: Mesh;
  readonly stencil: Stencil;
  readonly geometry = new BufferGeometry();
  readonly fineLabels: Uint8Array;
  coarse: Float32Array;
  params: BodyParams;
  appearance: Appearance = { skinTone: SKIN_TONES[2] };
  heightM = 1.93;
  private fine: Float32Array;
  private tris: Uint32Array;
  private coarseColors: Float32Array;
  private fineColors: Float32Array;

  constructor(readonly data: BodyData, params: BodyParams = defaultParams()) {
    this.stencil = buildCatmullClark(data.quads, data.meta.vertexCount);
    this.tris = quadsToTriangles(this.stencil.quads);
    this.fineLabels = new Uint8Array(this.stencil.fineCount);
    for (let i = 0; i < this.stencil.fineCount; i++) this.fineLabels[i] = data.labels[this.stencil.dominant[i]];
    this.coarse = new Float32Array(data.base.length);
    this.fine = new Float32Array(this.stencil.fineCount * 3);
    this.coarseColors = new Float32Array(data.meta.vertexCount * 3);
    this.fineColors = new Float32Array(this.stencil.fineCount * 3);
    this.geometry.setAttribute('position', new BufferAttribute(this.fine, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.fine.length), 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.fineColors, 3));
    this.geometry.setIndex(new BufferAttribute(this.tris, 1));
    const material = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0 });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.name = 'builder-body';
    this.mesh.frustumCulled = false;
    this.mesh.userData.partLabels = this.fineLabels;
    this.mesh.userData.partNames = data.meta.parts;
    this.mesh.userData.topology = BUILDER_TOPOLOGY;
    this.params = params;
    this.update(params, this.heightM);
    this.setAppearance(this.appearance);
  }

  /** Rebuild the shape. Fast enough to call on every slider move. */
  update(params: BodyParams, heightM: number): void {
    this.params = params;
    this.heightM = heightM;
    blendCoarse(this.data, params, this.coarse);
    applyStencil(this.stencil, this.coarse, 3, this.fine);
    normalise(this.fine, heightM);
    const n = computeNormals({ positions: this.fine, indices: this.tris });
    (this.geometry.getAttribute('normal') as BufferAttribute).set(n);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  setAppearance(a: Appearance): void {
    this.appearance = a;
    const mats = this.data.meta.materials;
    const col = (hex: string) => new Color(hex); // converted to linear by three.js
    const skin = col(a.skinTone);
    const table: Record<string, Color> = { skin, sclera: col(EYE.sclera), iris: col(EYE.iris), pupil: col(EYE.pupil) };
    const m = this.data.material;
    for (let i = 0; i < m.length; i++) {
      const c = table[mats[m[i]]] ?? skin;
      this.coarseColors[i * 3] = c.r; this.coarseColors[i * 3 + 1] = c.g; this.coarseColors[i * 3 + 2] = c.b;
    }
    applyStencil(this.stencil, this.coarseColors, 3, this.fineColors);
    this.geometry.getAttribute('color').needsUpdate = true;
  }

  bmi(): { bmi: number; massKg: number } { return estimateBmi(this.data, this.coarse, this.heightM); }

  dispose(): void { this.geometry.dispose(); (this.mesh.material as MeshStandardMaterial).dispose(); }
}
