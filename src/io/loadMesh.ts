// Load a body mesh from files picked on the device. Nothing is uploaded.
// Supports GLB/GLTF (with .bin and textures picked alongside), OBJ (+MTL and
// textures) and PLY. Files never leave the browser.

import { BufferGeometry, LoadingManager, Mesh, MeshStandardMaterial, Object3D, SRGBColorSpace, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { makeSkinMaterial } from '../viewer/skinMaterial';

export interface LoadedBody {
  object: Object3D;
  format: 'glb' | 'gltf' | 'obj' | 'ply';
  triangles: number;
  textured: boolean;
}

const ext = (name: string) => name.toLowerCase().split('.').pop() ?? '';

export async function loadBodyFiles(files: File[]): Promise<LoadedBody> {
  const main = files.find((f) => ['glb', 'gltf', 'obj', 'ply'].includes(ext(f.name)));
  if (!main) throw new Error('Pick a .glb, .gltf, .obj or .ply file (plus its textures if separate).');
  const format = ext(main.name) as LoadedBody['format'];

  // Map every picked file name to a blob URL so loaders can resolve sidecars.
  const urls = new Map<string, string>();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split('/').pop() ?? url).toLowerCase();
    return urls.get(base) ?? url;
  });
  const mainUrl = urls.get(main.name.toLowerCase())!;

  try {
    let object: Object3D;
    if (format === 'glb' || format === 'gltf') {
      const gltf = await new GLTFLoader(manager).loadAsync(mainUrl);
      object = gltf.scene;
    } else if (format === 'obj') {
      const loader = new OBJLoader(manager);
      const mtl = files.find((f) => ext(f.name) === 'mtl');
      if (mtl) {
        const materials = await new MTLLoader(manager).loadAsync(urls.get(mtl.name.toLowerCase())!);
        materials.preload();
        loader.setMaterials(materials);
      }
      object = await loader.loadAsync(mainUrl);
    } else {
      const geometry = (await new PLYLoader(manager).loadAsync(mainUrl)) as BufferGeometry;
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const hasColor = !!geometry.getAttribute('color');
      const mat = makeSkinMaterial();
      if (hasColor) { mat.vertexColors = true; mat.color.set(0xffffff); }
      object = new Mesh(geometry, mat);
    }
    // Wait for textures referenced by the loaders.
    await new Promise<void>((resolve) => {
      let pending = false;
      manager.onLoad = () => resolve();
      manager.onStart = () => { pending = true; };
      // If nothing else is loading, resolve on next tick.
      setTimeout(() => { if (!pending) resolve(); }, 50);
    });

    let triangles = 0, textured = false;
    object.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as BufferGeometry;
      triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const map = (mat as MeshStandardMaterial).map as Texture | null | undefined;
        if (map) { textured = true; map.colorSpace = SRGBColorSpace; }
        else if (!(mat as MeshStandardMaterial).vertexColors) m.material = makeSkinMaterial();
      }
      m.frustumCulled = false;
    });
    return { object, format, triangles: Math.round(triangles), textured };
  } finally {
    // Textures are decoded by now; URLs can go.
    setTimeout(() => { for (const u of urls.values()) URL.revokeObjectURL(u); }, 5000);
  }
}
