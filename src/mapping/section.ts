// Circumference of the body at a point: the closed loop where the plane
// through `point` with normal `axis` cuts the surface, followed from the
// seed triangle until it returns. Useful for armbands (wrap mode) and as a
// tape-measure readout.

import type { SurfaceMesh } from '../mesh/topology';

export interface Section {
  /** Loop length in metres. */
  length: number;
  /** True if the loop closed back on the start triangle. */
  closed: boolean;
  /** Polyline points (world metres), closed loop if `closed`. */
  points: Float32Array;
}

const edgeCache = new WeakMap<SurfaceMesh, Map<number, [number, number]>>();
function edgeMap(mesh: SurfaceMesh): Map<number, [number, number]> {
  let m = edgeCache.get(mesh);
  if (m) return m;
  m = new Map();
  const I = mesh.indices;
  for (let t = 0; t < I.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const e = m.get(key);
      if (!e) m.set(key, [t, -1]); else if (e[1] === -1 && e[0] !== t) e[1] = t;
    }
  }
  edgeCache.set(mesh, m);
  return m;
}

export function sectionLoop(mesh: SurfaceMesh, startTriIn: number, point: [number, number, number], axis: [number, number, number], maxSteps = 200000, display?: Float32Array): Section {
  let startTri = startTriIn;
  const P = mesh.positions, I = mesh.indices;
  const edges = edgeMap(mesh);
  const [ax, ay, az] = axis;
  // Shift the plane by 0.1 micrometre so no vertex lies exactly on it (rings of
  // vertices on a regular mesh would otherwise make the crossing ambiguous).
  const d0 = ax * point[0] + ay * point[1] + az * point[2] + 1e-7;
  const sd = (v: number) => ax * P[v * 3] + ay * P[v * 3 + 1] + az * P[v * 3 + 2] - d0;
  const crossPoint = (a: number, b: number): [number, number, number] => {
    const da = sd(a), db = sd(b);
    const t = da / (da - db);
    return [P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t];
  };
  const shown: number[] = [];
  const crossShown = (a: number, b: number) => {
    if (!display) return;
    const da = sd(a), db = sd(b), t = da / (da - db), D = display;
    shown.push(D[a * 3] + (D[b * 3] - D[a * 3]) * t, D[a * 3 + 1] + (D[b * 3 + 1] - D[a * 3 + 1]) * t, D[a * 3 + 2] + (D[b * 3 + 2] - D[a * 3 + 2]) * t);
  };
  /** Edges (as [va, vb]) of triangle t crossed by the plane. */
  const crossedEdges = (t: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      const da = sd(a), db = sd(b);
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) out.push([a, b]);
    }
    return out;
  };
  let start = crossedEdges(startTri);
  if (start.length < 2) {
    // The point sits on a vertex or edge, so the plane only touches this
    // triangle. Start from the nearest neighbouring triangle it does cut.
    let best = -1, bestD = Infinity;
    for (let k = 0; k < 3; k++) {
      const v = I[startTri * 3 + k];
      for (let j = mesh.triOffset[v]; j < mesh.triOffset[v + 1]; j++) {
        const t = mesh.vertTris[j];
        if (crossedEdges(t).length < 2) continue;
        let cx = 0, cy = 0, cz = 0;
        for (let m = 0; m < 3; m++) { const u = I[t * 3 + m] * 3; cx += P[u] / 3; cy += P[u + 1] / 3; cz += P[u + 2] / 3; }
        const d = Math.hypot(cx - point[0], cy - point[1], cz - point[2]);
        if (d < bestD) { bestD = d; best = t; }
      }
    }
    if (best < 0) return { length: 0, closed: false, points: new Float32Array(0) };
    startTri = best;
    start = crossedEdges(startTri);
  }
  const pts: number[] = [];
  let length = 0;
  let tri = startTri;
  let edge = start[0];
  let prev = crossPoint(edge[0], edge[1]);
  pts.push(...prev);
  crossShown(edge[0], edge[1]);
  let closed = false;
  for (let step = 0; step < maxSteps; step++) {
    const key = edge[0] < edge[1] ? edge[0] * 4294967296 + edge[1] : edge[1] * 4294967296 + edge[0];
    const pair = edges.get(key);
    const next = pair ? (pair[0] === tri ? pair[1] : pair[0]) : -1;
    if (next < 0) break;
    const ce = crossedEdges(next).filter((e) => !((e[0] === edge[0] && e[1] === edge[1]) || (e[0] === edge[1] && e[1] === edge[0])));
    if (ce.length === 0) break;
    edge = ce[0]; tri = next;
    const p = crossPoint(edge[0], edge[1]);
    length += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    pts.push(...p); prev = p;
    crossShown(edge[0], edge[1]);
    if (tri === startTri) { closed = true; break; }
  }
  if (closed) {
    const p0: [number, number, number] = [pts[0], pts[1], pts[2]];
    // The last point is on the start triangle's other crossed edge; the loop is complete.
    length += 0; // already includes the segment back onto the start triangle
    void p0;
  }
  return { length, closed, points: new Float32Array(display ? shown : pts) };
}
