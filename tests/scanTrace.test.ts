import { describe, expect, it } from 'vitest';
import { cylinderMesh } from './helpers/analytic';
import { surfaceFromIndexed } from '../src/mesh/topology';
import { computeExpMap, normalAt, barycentric, tangentFrom } from '../src/mapping/expmap';
import { PatchLocator } from '../src/mapping/locate';
import { makeImage } from '../src/existing/image';
import { extractInk } from '../src/existing/inkExtract';
import { renderSkin, type ScanTexture } from '../src/existing/scanTrace';

describe('tattoo from a textured scan', () => {
  it('recovers a 6 cm circle drawn in the texture at its true size and shape', () => {
    // A limb-like cylinder (radius 4.5 cm) whose texture wraps once around it.
    const R = 0.045, Hc = 0.4;
    const surface = surfaceFromIndexed(cylinderMesh(R, Hc, 160, 80));
    const P = surface.positions, I = surface.indices, nT = I.length / 3;
    const uvOf = (v: number) => {
      const a = Math.atan2(P[v * 3 + 2], P[v * 3]);
      return [((a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI)), P[v * 3 + 1] / Hc + 0.5];
    };
    const triUv = new Float32Array(nT * 6);
    for (let t = 0; t < nT; t++) {
      const uvs = [0, 1, 2].map((c) => uvOf(I[t * 3 + c]));
      // Triangles across the seam (u jumps from ~1 to ~0) get NaN: the test stays away from it.
      const us = uvs.map((q) => q[0]);
      const seam = Math.max(...us) - Math.min(...us) > 0.5;
      uvs.forEach((q, c) => { triUv[t * 6 + c * 2] = seam ? NaN : q[0]; triUv[t * 6 + c * 2 + 1] = q[1]; });
    }
    // Texture 2048 x 1024: skin colour with a black disk 6 cm across at u = 0.5 (opposite the seam), v = 0.5.
    const W = 2048, H = 1024, img = makeImage(W, H);
    const circ = 2 * Math.PI * R;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const du = ((x + 0.5) / W - 0.5) * circ, dv = ((y + 0.5) / H - 0.5) * Hc;
      const o = (y * W + x) * 4;
      const ink = Math.hypot(du, dv) < 0.03;
      img.data[o] = ink ? 20 : 220; img.data[o + 1] = ink ? 20 : 175; img.data[o + 2] = ink ? 25 : 150; img.data[o + 3] = 255;
    }
    const tex: ScanTexture = { triUv, triTex: new Uint8Array(nT), textures: [{ img, flipY: false }] };
    // Anchor on the skin at the disk's centre: angle pi (x = -R), height 0.
    // The point sits a little off the mesh's vertices and edges so one triangle clearly contains it.
    const point: [number, number, number] = [-R * Math.cos(0.004), 0.0013, R * Math.sin(0.004)];
    let tri = -1;
    for (let t = 0; t < nT && tri < 0; t++) {
      const xs = [0, 1, 2].map((c) => P[I[t * 3 + c] * 3]);
      if (Math.max(...xs) > -R * 0.99) continue;
      const b = barycentric(surface, t, point);
      if (b.every((x) => x > -1e-6)) tri = t;
    }
    expect(tri).toBeGreaterThanOrEqual(0);
    const normal = normalAt(surface, tri, barycentric(surface, tri, point));
    const tangent = tangentFrom(normal, [0, 1, 0]);
    const patch = computeExpMap(surface, { tri, point, normal, tangent }, { radius: 0.07, exact: true, smoothPasses: 3 });
    const loc = new PatchLocator(surface, patch);
    const size = 0.09, px = 720; // 8 px per mm
    const flat = renderSkin((u, v) => loc.locateTri(u, v), tex, size, px);
    const ink = extractInk(flat, { floor: 0.3 });
    expect(ink.bbox).not.toBeNull();
    const mm = (n: number) => (n * size * 1000) / px;
    const w = mm(ink.bbox!.x1 - ink.bbox!.x0), h = mm(ink.bbox!.y1 - ink.bbox!.y0);
    expect(Math.abs(w - 60) / 60).toBeLessThan(0.02); // around the limb
    expect(Math.abs(h - 60) / 60).toBeLessThan(0.02); // along it
    // Centred where it was tapped.
    const cx = mm((ink.bbox!.x0 + ink.bbox!.x1) / 2) - (size * 1000) / 2, cy = mm((ink.bbox!.y0 + ink.bbox!.y1) / 2) - (size * 1000) / 2;
    // The anchor is 1.3 mm along the limb and 0.18 mm around from the disk's centre:
    // the disk appears exactly that far from the image centre.
    expect(Math.abs(Math.hypot(cx, cy) - Math.hypot(1.3, 0.18))).toBeLessThan(0.5);
  });
});
