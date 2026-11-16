import { MeshStandardMaterial } from 'three';

/** Neutral skin-like material for untextured bodies. */
export function makeSkinMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0xd8b49a, roughness: 0.62, metalness: 0.0 });
}
