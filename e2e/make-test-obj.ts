// Writes a Z-up OBJ of the placeholder body (as a photogrammetry export would be) for loader tests.
import { writeFileSync } from 'node:fs';
import { buildMannequin } from '../src/body/mannequin';
const m = buildMannequin({ height: 1.93, cell: 0.015 });
const lines: string[] = ['# synthetic test body, Z up, arbitrary scale', 'mtllib body.mtl', 'o body', 'usemtl skin'];
for (let i = 0; i < m.positions.length; i += 3) {
  // Y-up -> Z-up (x, y, z) -> (x, -z, y), scaled by 37 (arbitrary units) and facing -X after a turn
  const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
  lines.push(`v ${(-z * 37).toFixed(4)} ${(-x * 37).toFixed(4)} ${(y * 37).toFixed(4)}`);
}
for (let i = 0; i < m.indices.length; i += 3) lines.push(`f ${m.indices[i] + 1} ${m.indices[i + 1] + 1} ${m.indices[i + 2] + 1}`);
writeFileSync(process.argv[2] + '/body.obj', lines.join('\n'));
writeFileSync(process.argv[2] + '/body.mtl', 'newmtl skin\nKd 0.85 0.70 0.60\n');
console.log('obj written', m.indices.length / 3, 'tris');
