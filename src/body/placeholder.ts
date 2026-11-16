import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import { makeSkinMaterial } from '../viewer/skinMaterial';
import { buildMannequin } from './mannequin';
import { computeNormals } from '../mesh/marchingCubes';

/** Placeholder body as a three.js mesh, standing on y=0 at the given height. */
export function makePlaceholderBody(heightM: number, cell = 0.01): { mesh: Mesh; triangles: number } {
  const m = buildMannequin({ height: heightM, cell });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(computeNormals(m), 3));
  g.setIndex(new BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  const mesh = new Mesh(g, makeSkinMaterial());
  mesh.name = 'placeholder-body';
  return { mesh, triangles: m.indices.length / 3 };
}
