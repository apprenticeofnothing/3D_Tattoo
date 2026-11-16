// Geometry and material for one design placed on the skin. The design's
// stencil coordinates (metres along the skin, from the exponential map) are
// turned into texture coordinates; the heatmap colours come from the
// ring-averaged stretch.

import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, MultiplyBlending, NormalBlending, ShaderMaterial, Texture,
} from 'three';
import type { SurfaceMesh } from '../mesh/topology';
import type { Patch } from './expmap';
import type { VertexStretch } from './distortion';

export interface DecalParams {
  /** Design width along the skin (metres). */
  width: number;
  /** Design height along the skin (metres). */
  height: number;
  mirror: boolean;
  /** Wrap mode: repeat the design around the limb with period = width. */
  wrap: boolean;
  /** Circumference (metres) used to unwrap seam triangles in wrap mode. */
  circumference: number;
}

const vertexShader = /* glsl */ `
  attribute vec3 heat;
  varying vec2 vUv;
  varying vec3 vHeat;
  void main() {
    vUv = uv;
    vHeat = heat;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform float opacity;
  uniform int mode;      // 0 = stencil, 1 = inked skin, 2 = heatmap
  uniform bool wrap;
  varying vec2 vUv;
  varying vec3 vHeat;
  void main() {
    vec2 st = vUv;
    if (st.y < 0.0 || st.y > 1.0) discard;
    if (!wrap && (st.x < 0.0 || st.x > 1.0)) discard;
    if (wrap) st.x = fract(st.x);
    if (mode == 2) {
      gl_FragColor = vec4(vHeat, 0.9);
    } else {
      // Inked skin: sample a slightly blurred level so edges soften like real ink.
      vec4 c = mode == 1 ? texture2D(map, st, 1.0) : texture2D(map, st);
      if (mode == 1) {
        // Ink sits in the skin: multiply blend, slightly lower contrast.
        vec3 ink = mix(vec3(1.0), c.rgb * 0.85 + 0.05, c.a * opacity);
        gl_FragColor = vec4(ink, 1.0);
      } else {
        gl_FragColor = vec4(c.rgb, c.a * opacity);
      }
    }
    #include <colorspace_fragment>
    gl_FragColor.rgb *= gl_FragColor.a; // premultiplied output (needed for multiply blending)
  }
`;

export type DecalMode = 'stencil' | 'inked' | 'heatmap';

export class DecalObject {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private geometry = new BufferGeometry();

  constructor(texture: Texture) {
    this.material = new ShaderMaterial({
      uniforms: { map: { value: texture }, opacity: { value: 1 }, mode: { value: 0 }, wrap: { value: false } },
      vertexShader, fragmentShader,
      transparent: true, depthWrite: false, side: DoubleSide, premultipliedAlpha: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
  }

  setTexture(t: Texture) { this.material.uniforms.map.value = t; }
  setOpacity(o: number) { this.material.uniforms.opacity.value = o; }
  setMode(m: DecalMode) {
    this.material.uniforms.mode.value = m === 'stencil' ? 0 : m === 'inked' ? 1 : 2;
    this.material.blending = m === 'inked' ? MultiplyBlending : NormalBlending;
    this.material.needsUpdate = true;
  }

  /** Rebuild the geometry for a patch. */
  build(surface: SurfaceMesh, patch: Patch, params: DecalParams, stretch: VertexStretch | null): void {
    const { positions: P, indices: I } = surface;
    const { width: W, height: H, mirror, wrap, circumference: C } = params;
    this.material.uniforms.wrap.value = wrap;
    const triLists = wrap ? [patch.tris, patch.seamTris] : [patch.tris];
    // Only keep triangles that can show any part of the design.
    const margin = 0.002;
    const keep: number[] = [];
    const uvs: number[] = [];
    for (const list of triLists) {
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const l = [patch.local[I[t * 3]], patch.local[I[t * 3 + 1]], patch.local[I[t * 3 + 2]]];
        let u = [patch.uv[l[0] * 2], patch.uv[l[1] * 2], patch.uv[l[2] * 2]];
        const v = [patch.uv[l[0] * 2 + 1], patch.uv[l[1] * 2 + 1], patch.uv[l[2] * 2 + 1]];
        if (wrap && C > 0) {
          // Unwrap triangles straddling the back seam.
          const mx = Math.max(...u), mn = Math.min(...u);
          if (mx - mn > C / 2) u = u.map((x) => (x < 0 ? x + C : x));
        }
        const minV = Math.min(...v), maxV = Math.max(...v);
        if (maxV < -H / 2 - margin || minV > H / 2 + margin) continue;
        if (!wrap) {
          const minU = Math.min(...u), maxU = Math.max(...u);
          if (maxU < -W / 2 - margin || minU > W / 2 + margin) continue;
        }
        keep.push(t);
        for (let k = 0; k < 3; k++) {
          const uu = mirror ? -u[k] : u[k];
          uvs.push(uu / W + 0.5, v[k] / H + 0.5);
        }
      }
    }
    const n = keep.length * 3;
    const pos = new Float32Array(n * 3);
    const heat = new Float32Array(n * 3);
    const col = new Color();
    for (let i = 0; i < keep.length; i++) {
      const t = keep[i];
      for (let k = 0; k < 3; k++) {
        const g = I[t * 3 + k];
        const o = (i * 3 + k) * 3;
        pos[o] = P[g * 3]; pos[o + 1] = P[g * 3 + 1]; pos[o + 2] = P[g * 3 + 2];
        const li = patch.local[g];
        const e = stretch && li >= 0 ? signedStretch(stretch.sMax[li], stretch.sMin[li]) : NaN;
        heatColor(e, col);
        heat[o] = col.r; heat[o + 1] = col.g; heat[o + 2] = col.b;
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    g.setAttribute('heat', new BufferAttribute(heat, 3));
    this.geometry.dispose();
    this.geometry = g;
    this.mesh.geometry = g;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/** The principal stretch with the largest deviation from 1, as a signed fraction. */
export function signedStretch(sMax: number, sMin: number): number {
  const a = sMax - 1, b = sMin - 1;
  return Math.abs(a) >= Math.abs(b) ? a : b;
}

/**
 * Diverging colour scale: blue = compression (stencil wrinkles), red =
 * stretch (stencil tears). Pale below 2%, strong above 5%, saturated at 10%.
 */
export function heatColor(e: number, out: Color): Color {
  if (!Number.isFinite(e)) return out.setRGB(0.5, 0.5, 0.5);
  const a = Math.min(1, Math.abs(e) / 0.10);
  const warn = Math.abs(e) >= 0.05;
  const base = e > 0 ? [0.85, 0.15, 0.1] : [0.1, 0.35, 0.95];
  const t = warn ? 0.65 + 0.35 * a : a * 0.5;
  const r = 0.93 + (base[0] - 0.93) * t, g = 0.93 + (base[1] - 0.93) * t, b = 0.93 + (base[2] - 0.93) * t;
  return out.setRGB(r, g, b, 'srgb');
}
