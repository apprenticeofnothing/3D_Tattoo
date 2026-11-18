// Writes a textured "scan" for the pick-up-from-scan check: a cylinder
// 1.93 m tall (so the app does not rescale it) with radius 15 cm, wrapped
// in a skin-coloured texture that has a dark disk 8 cm across on the front
// (+Z) at 1.158 m. OBJ + MTL + PNG, Y up, metres.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/capture/zip';

const out = process.argv[2];
const H = 1.93, R = 0.15, SEG = 192, ROWS = 96;
const lines = ['# synthetic textured scan', 'mtllib scan.mtl', 'o scan', 'usemtl skin'];
for (let j = 0; j <= ROWS; j++) for (let i = 0; i <= SEG; i++) {
  const a = (2 * Math.PI * i) / SEG;
  lines.push(`v ${(R * Math.cos(a)).toFixed(5)} ${((H * j) / ROWS).toFixed(5)} ${(R * Math.sin(a)).toFixed(5)}`);
}
for (let j = 0; j <= ROWS; j++) for (let i = 0; i <= SEG; i++) lines.push(`vt ${(i / SEG).toFixed(6)} ${(j / ROWS).toFixed(6)}`);
const id = (i: number, j: number) => j * (SEG + 1) + i + 1;
// Outward-facing triangles (counter-clockwise seen from outside).
for (let j = 0; j < ROWS; j++) for (let i = 0; i < SEG; i++) {
  const a = id(i, j), b = id(i + 1, j), c = id(i, j + 1), d = id(i + 1, j + 1);
  lines.push(`f ${a}/${a} ${c}/${c} ${b}/${b}`, `f ${b}/${b} ${c}/${c} ${d}/${d}`);
}
writeFileSync(`${out}/scan.obj`, lines.join('\n'));
writeFileSync(`${out}/scan.mtl`, 'newmtl skin\nKd 1 1 1\nmap_Kd scan.png\n');

// Texture: u = angle / 2pi, v = height / H (OBJ convention: v up). The disk is
// round on the skin, so an ellipse in texture pixels.
const TW = 2048, TH = 2048, circ = 2 * Math.PI * R;
const u0 = 0.25, v0 = 1.158 / H, rM = 0.04; // angle pi/2 is +Z (the front)
const raw = Buffer.alloc(TH * (1 + TW * 3));
for (let y = 0; y < TH; y++) {
  raw[y * (1 + TW * 3)] = 0;
  const v = 1 - (y + 0.5) / TH; // image rows run top to bottom
  for (let x = 0; x < TW; x++) {
    const u = (x + 0.5) / TW;
    const ink = Math.hypot((u - u0) * circ, (v - v0) * H) < rM;
    const o = y * (1 + TW * 3) + 1 + x * 3;
    raw[o] = ink ? 25 : 222; raw[o + 1] = ink ? 22 : 178; raw[o + 2] = ink ? 28 : 152;
  }
}
const chunk = (type: string, data: Buffer) => {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8);
  b.writeUInt32BE(crc32(new Uint8Array(b.subarray(4, 8 + data.length))) >>> 0, 8 + data.length);
  return b;
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(TW, 0); ihdr.writeUInt32BE(TH, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(`${out}/scan.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`textured scan written to ${out}`);
