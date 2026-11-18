// Catmull–Clark subdivision of a quad mesh, precomputed as a linear stencil.
// The body builder changes positions on every slider move but never the
// connectivity, so the subdivision is built once as sparse weights
// (fine vertex = sum of w * coarse vertex) and applied in a few milliseconds.
//
// Fine vertex order: [vertex points (nV)] [edge points (nE)] [face points (nF)].

export interface Stencil {
  /** CSR: weights of fine vertex i are entries offsets[i] .. offsets[i+1]. */
  offsets: Uint32Array;
  indices: Uint32Array;
  weights: Float32Array;
  fineCount: number;
  /** Fine quads (4 indices per quad). */
  quads: Uint32Array;
  /** For each fine vertex, the coarse vertex with the largest weight (for labels). */
  dominant: Uint32Array;
  edgeCount: number;
}

type Sparse = Map<number, number>;
const add = (m: Sparse, k: number, w: number) => m.set(k, (m.get(k) ?? 0) + w);

export function buildCatmullClark(quads: ArrayLike<number>, vertexCount: number): Stencil {
  const nF = quads.length / 4;
  // Edges
  const edgeId = new Map<number, number>();
  const edgeV: number[] = [];
  const edgeFaces: number[][] = [];
  const key = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  const faceEdges = new Uint32Array(nF * 4);
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 4; k++) {
      const a = quads[f * 4 + k], b = quads[f * 4 + ((k + 1) % 4)];
      const kk = key(a, b);
      let e = edgeId.get(kk);
      if (e === undefined) { e = edgeV.length / 2; edgeId.set(kk, e); edgeV.push(a, b); edgeFaces.push([]); }
      edgeFaces[e].push(f);
      faceEdges[f * 4 + k] = e;
    }
  }
  const nE = edgeV.length / 2;
  // Vertex -> incident faces and edges
  const vFaces: number[][] = Array.from({ length: vertexCount }, () => []);
  const vEdges: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let f = 0; f < nF; f++) for (let k = 0; k < 4; k++) vFaces[quads[f * 4 + k]].push(f);
  for (let e = 0; e < nE; e++) { vEdges[edgeV[e * 2]].push(e); vEdges[edgeV[e * 2 + 1]].push(e); }

  const faceStencil = (f: number, scale: number, out: Sparse) => {
    for (let k = 0; k < 4; k++) add(out, quads[f * 4 + k], 0.25 * scale);
  };
  const stencils: Sparse[] = [];
  // Vertex points
  for (let v = 0; v < vertexCount; v++) {
    const s: Sparse = new Map();
    const edges = vEdges[v];
    const boundary = edges.filter((e) => edgeFaces[e].length === 1);
    if (edges.length === 0) { s.set(v, 1); }
    else if (boundary.length >= 2) {
      // Boundary vertex: cubic B-spline along the boundary.
      add(s, v, 6 / 8);
      for (const e of boundary.slice(0, 2)) add(s, edgeV[e * 2] === v ? edgeV[e * 2 + 1] : edgeV[e * 2], 1 / 8);
    } else {
      const n = edges.length;
      const faces = vFaces[v];
      for (const f of faces) faceStencil(f, 1 / (n * faces.length) * (n / n), s); // F / n with F = mean of face points
      // Re-scale: the line above adds (1/n) * mean(face points).
      for (const e of edges) {
        const o = edgeV[e * 2] === v ? edgeV[e * 2 + 1] : edgeV[e * 2];
        add(s, v, (2 / n) * (0.5 / n));
        add(s, o, (2 / n) * (0.5 / n));
      }
      add(s, v, (n - 3) / n);
    }
    stencils.push(s);
  }
  // Edge points
  for (let e = 0; e < nE; e++) {
    const s: Sparse = new Map();
    const a = edgeV[e * 2], b = edgeV[e * 2 + 1];
    const faces = edgeFaces[e];
    if (faces.length === 2) {
      add(s, a, 0.25); add(s, b, 0.25);
      for (const f of faces) faceStencil(f, 0.25, s);
    } else {
      add(s, a, 0.5); add(s, b, 0.5);
    }
    stencils.push(s);
  }
  // Face points
  for (let f = 0; f < nF; f++) {
    const s: Sparse = new Map();
    faceStencil(f, 1, s);
    stencils.push(s);
  }

  const fineCount = vertexCount + nE + nF;
  const offsets = new Uint32Array(fineCount + 1);
  let total = 0;
  for (let i = 0; i < fineCount; i++) { total += stencils[i].size; offsets[i + 1] = total; }
  const indices = new Uint32Array(total), weights = new Float32Array(total), dominant = new Uint32Array(fineCount);
  for (let i = 0, o = 0; i < fineCount; i++) {
    let best = -1, bw = -Infinity;
    for (const [k, w] of stencils[i]) {
      indices[o] = k; weights[o] = w; o++;
      if (w > bw) { bw = w; best = k; }
    }
    dominant[i] = best;
  }
  // Fine quads: each coarse face splits into four, keeping orientation.
  const fq = new Uint32Array(nF * 16);
  for (let f = 0; f < nF; f++) {
    const fp = vertexCount + nE + f;
    for (let k = 0; k < 4; k++) {
      const v = quads[f * 4 + k];
      const eNext = vertexCount + faceEdges[f * 4 + k];
      const ePrev = vertexCount + faceEdges[f * 4 + ((k + 3) % 4)];
      fq.set([v, eNext, fp, ePrev], f * 16 + k * 4);
    }
  }
  return { offsets, indices, weights, fineCount, quads: fq, dominant, edgeCount: nE };
}

/** Apply a stencil to an interleaved attribute with `size` components per vertex. */
export function applyStencil(st: Stencil, coarse: ArrayLike<number>, size: number, out?: Float32Array): Float32Array {
  const res = out ?? new Float32Array(st.fineCount * size);
  const { offsets, indices, weights } = st;
  if (size === 3) {
    for (let i = 0; i < st.fineCount; i++) {
      let x = 0, y = 0, z = 0;
      for (let k = offsets[i]; k < offsets[i + 1]; k++) {
        const j = indices[k] * 3, w = weights[k];
        x += w * coarse[j]; y += w * coarse[j + 1]; z += w * coarse[j + 2];
      }
      res[i * 3] = x; res[i * 3 + 1] = y; res[i * 3 + 2] = z;
    }
    return res;
  }
  for (let i = 0; i < st.fineCount; i++) {
    for (let c = 0; c < size; c++) {
      let acc = 0;
      for (let k = offsets[i]; k < offsets[i + 1]; k++) acc += weights[k] * coarse[indices[k] * size + c];
      res[i * size + c] = acc;
    }
  }
  return res;
}

/** Split quads into triangles (two per quad, consistent orientation). */
export function quadsToTriangles(quads: ArrayLike<number>): Uint32Array {
  const n = quads.length / 4;
  const out = new Uint32Array(n * 6);
  for (let f = 0; f < n; f++) {
    const a = quads[f * 4], b = quads[f * 4 + 1], c = quads[f * 4 + 2], d = quads[f * 4 + 3];
    out.set([a, b, c, a, c, d], f * 6);
  }
  return out;
}
