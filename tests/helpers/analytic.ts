// Analytic test surfaces with regular triangulation.
import type { IndexedMesh } from '../../src/mesh/marchingCubes';

/** Open cylinder of radius r, height h, axis along Y, centred at origin. */
export function cylinderMesh(r: number, h: number, segs = 128, rows = 64): IndexedMesh {
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const y = -h / 2 + (h * j) / rows;
    for (let i = 0; i < segs; i++) {
      const a = (2 * Math.PI * i) / segs;
      pos.push(r * Math.cos(a), y, r * Math.sin(a));
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < segs; i++) {
      const i1 = (i + 1) % segs;
      const a = j * segs + i, b = j * segs + i1, c = (j + 1) * segs + i, d = (j + 1) * segs + i1;
      // Alternate the diagonal to avoid a directional bias.
      if ((i + j) % 2 === 0) idx.push(a, c, b, b, c, d); else idx.push(a, d, b, a, c, d);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** UV sphere of radius r at origin, poles on Y. */
export function sphereMesh(r: number, segs = 192, rings = 96): IndexedMesh {
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const th = (Math.PI * j) / rings;
    for (let i = 0; i < segs; i++) {
      const ph = (2 * Math.PI * i) / segs;
      pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph));
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const i1 = (i + 1) % segs;
      const a = j * segs + i, b = j * segs + i1, c = (j + 1) * segs + i, d = (j + 1) * segs + i1;
      if (j > 0) idx.push(a, b, c);
      if (j < rings - 1) idx.push(b, d, c);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
