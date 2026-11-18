// Welded triangle surface with adjacency, built from any three.js body or
// from an IndexedMesh. Positions are in world space (metres). Vertices that
// share a position (e.g. split at texture seams in a GLB) are merged so
// geodesic walks can cross them.

import { Matrix4, Mesh, Object3D, Vector3 } from 'three';
import type { IndexedMesh } from './marchingCubes';
import { computeNormals } from './marchingCubes';

export interface SurfaceMesh {
  positions: Float32Array; // welded, world space
  normals: Float32Array; // area weighted, unit
  indices: Uint32Array; // triangles over welded ids
  /** CSR vertex adjacency: neighbours of v are adj[adjOffset[v] .. adjOffset[v+1]). */
  adjOffset: Uint32Array;
  adj: Uint32Array;
  /** CSR vertex->triangle incidence. */
  triOffset: Uint32Array;
  vertTris: Uint32Array;
  /** For each source mesh: first global triangle index, so a raycast hit maps to a triangle. */
  sources: { mesh: Mesh; triStart: number; triCount: number }[];
  /** Original (pre-weld) triangle index -> surface triangle index, or -1 if it collapsed. */
  triRemap: Int32Array | null;
  /** Optional body-part label per vertex (from a body with a skeleton, e.g. the body builder). */
  labels?: Uint8Array;
  partNames?: string[];
  /** Identifier of the mesh connectivity, when the body comes from a known family. */
  topology?: string;
}

/** Build a SurfaceMesh from an IndexedMesh already in world space. */
export function surfaceFromIndexed(m: IndexedMesh): SurfaceMesh {
  return finish(m.positions, m.indices, [], null);
}

/** Build a SurfaceMesh from every Mesh under `root`, in world space. */
export function surfaceFromObject(root: Object3D): SurfaceMesh {
  root.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  root.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
  const posChunks: Float32Array[] = [];
  const idxChunks: Uint32Array[] = [];
  const labelChunks: (Uint8Array | null)[] = [];
  let partNames: string[] | undefined;
  let topology: string | undefined;
  const sources: SurfaceMesh['sources'] = [];
  let vertBase = 0, triBase = 0;
  const v = new Vector3();
  const m4 = new Matrix4();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pa = g.getAttribute('position');
    const n = pa.count;
    const out = new Float32Array(n * 3);
    m4.copy(mesh.matrixWorld);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(m4);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    let idx: Uint32Array;
    if (g.index) {
      idx = new Uint32Array(g.index.count);
      for (let i = 0; i < idx.length; i++) idx[i] = g.index.getX(i) + vertBase;
    } else {
      idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i + vertBase;
    }
    posChunks.push(out); idxChunks.push(idx);
    const ud = mesh.userData as { partLabels?: Uint8Array; partNames?: string[]; topology?: string };
    labelChunks.push(ud.partLabels && ud.partLabels.length === n ? ud.partLabels : null);
    if (ud.partNames) partNames = ud.partNames;
    if (ud.topology && meshes.length === 1) topology = ud.topology;
    sources.push({ mesh, triStart: triBase, triCount: idx.length / 3 });
    vertBase += n; triBase += idx.length / 3;
  }
  const positions = concat(posChunks, Float32Array);
  const indices = concat(idxChunks, Uint32Array);
  const welded = weld(positions, indices);
  const surface = finish(welded.positions, welded.indices, sources, welded.triRemap);
  if (partNames && labelChunks.some(Boolean)) {
    const labels = new Uint8Array(welded.positions.length / 3).fill(255);
    let o = 0;
    for (const chunk of labelChunks) {
      const n = chunk ? chunk.length : 0;
      if (chunk) for (let i = 0; i < n; i++) { const w = welded.remap[o + i]; if (labels[w] === 255) labels[w] = chunk[i]; }
      o += chunk ? n : 0;
    }
    surface.labels = labels; surface.partNames = partNames;
  }
  surface.topology = topology;
  return surface;
}

function concat<T extends Float32Array | Uint32Array>(chunks: T[], Ctor: { new (n: number): T }): T {
  let total = 0; for (const c of chunks) total += c.length;
  const out = new Ctor(total);
  let o = 0; for (const c of chunks) { out.set(c as never, o); o += c.length; }
  return out;
}

/** Merge vertices closer than `tol` metres. */
export function weld(positions: Float32Array, indices: Uint32Array, tol = 1e-5): { positions: Float32Array; indices: Uint32Array; remap: Uint32Array; triRemap: Int32Array } {
  const n = positions.length / 3;
  const remap = new Uint32Array(n);
  const map = new Map<string, number>();
  const outPos: number[] = [];
  const q = 1 / tol;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) { id = outPos.length / 3; map.set(key, id); outPos.push(x, y, z); }
    remap[i] = id;
  }
  const outIdx: number[] = [];
  const triRemap = new Int32Array(indices.length / 3).fill(-1);
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue; // collapsed by welding
    triRemap[t / 3] = outIdx.length / 3;
    outIdx.push(a, b, c);
  }
  return { positions: new Float32Array(outPos), indices: new Uint32Array(outIdx), remap, triRemap };
}

function finish(positions: Float32Array, indices: Uint32Array, sources: SurfaceMesh['sources'], triRemap: Int32Array | null): SurfaceMesh {
  const n = positions.length / 3;
  const normals = computeNormals({ positions, indices });
  // vertex -> triangles
  const triCount = new Uint32Array(n + 1);
  for (let i = 0; i < indices.length; i++) triCount[indices[i] + 1]++;
  for (let i = 0; i < n; i++) triCount[i + 1] += triCount[i];
  const triOffset = triCount;
  const vertTris = new Uint32Array(indices.length);
  const fill = triOffset.slice(0, n);
  for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) vertTris[fill[indices[t + k]]++] = t / 3;
  // vertex -> neighbours (unique)
  const adjOffset = new Uint32Array(n + 1);
  const adjList: number[] = [];
  const seen = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    for (let k = triOffset[v]; k < triOffset[v + 1]; k++) {
      const t = vertTris[k] * 3;
      for (let j = 0; j < 3; j++) {
        const w = indices[t + j];
        if (w !== v && seen[w] !== v) { seen[w] = v; adjList.push(w); }
      }
    }
    adjOffset[v + 1] = adjList.length;
  }
  return { positions, normals, indices, adjOffset, adj: new Uint32Array(adjList), triOffset, vertTris, sources, triRemap };
}

/** Global triangle index for a raycast hit on one of the source meshes. */
export function triangleForHit(surface: SurfaceMesh, mesh: Mesh, faceIndex: number): number {
  const s = surface.sources.find((x) => x.mesh === mesh);
  if (!s) throw new Error('hit mesh is not part of the surface');
  const original = s.triStart + faceIndex;
  const t = surface.triRemap ? surface.triRemap[original] : original;
  if (t < 0) throw new Error('hit a degenerate triangle; tap again');
  return t;
}
