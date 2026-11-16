// Signed distance primitives (metres). Negative inside.
// Written without per-call allocations because they run millions of times
// when a body is sampled onto a grid.

export type Vec3 = readonly [number, number, number];

export interface Ellipsoid { kind: 'ellipsoid'; cx: number; cy: number; cz: number; rx: number; ry: number; rz: number; k: number }
export interface Capsule { kind: 'capsule'; ax: number; ay: number; az: number; bx: number; by: number; bz: number; ra: number; rb: number; k: number }
export type Primitive = Ellipsoid | Capsule;

export function ellipsoid(c: Vec3, r: Vec3, k: number): Ellipsoid {
  return { kind: 'ellipsoid', cx: c[0], cy: c[1], cz: c[2], rx: r[0], ry: r[1], rz: r[2], k };
}
/** Capsule / round cone: segment a->b with radius ra at a and rb at b (linear taper). */
export function capsule(a: Vec3, b: Vec3, ra: number, rb: number, k: number): Capsule {
  return { kind: 'capsule', ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], ra, rb, k };
}

export function sdSphere(px: number, py: number, pz: number, c: Vec3, r: number): number {
  const dx = px - c[0], dy = py - c[1], dz = pz - c[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Approximate ellipsoid SDF (exact on axes, slightly off elsewhere; fine for modelling). */
export function sdEllipsoid(px: number, py: number, pz: number, e: Ellipsoid): number {
  const x = (px - e.cx) / e.rx, y = (py - e.cy) / e.ry, z = (pz - e.cz) / e.rz;
  const k0 = Math.sqrt(x * x + y * y + z * z);
  const x1 = x / e.rx, y1 = y / e.ry, z1 = z / e.rz;
  const k1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);
  return k1 === 0 ? -Math.min(e.rx, e.ry, e.rz) : (k0 * (k0 - 1)) / k1;
}

export function sdCapsule(px: number, py: number, pz: number, c: Capsule): number {
  const bax = c.bx - c.ax, bay = c.by - c.ay, baz = c.bz - c.az;
  const pax = px - c.ax, pay = py - c.ay, paz = pz - c.az;
  const l2 = bax * bax + bay * bay + baz * baz;
  let t = l2 > 0 ? (pax * bax + pay * bay + paz * baz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = pax - bax * t, dy = pay - bay * t, dz = paz - baz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (c.ra + (c.rb - c.ra) * t);
}

/** Smooth union (polynomial smooth min). k is the blend radius in metres. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}

/** Smooth union of a list of primitives, each blended with its own k. */
export function sdUnion(px: number, py: number, pz: number, prims: readonly Primitive[]): number {
  let d = Infinity;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    const v = p.kind === 'ellipsoid' ? sdEllipsoid(px, py, pz, p) : sdCapsule(px, py, pz, p);
    d = smin(d, v, p.k);
  }
  return d;
}
