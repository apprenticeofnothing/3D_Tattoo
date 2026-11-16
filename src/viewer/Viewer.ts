// Three.js scene, camera, controls and render loop. Renders only when
// something changed, which keeps a phone cool and the battery alive.
// Supports a split "compare" view: two viewports, same camera, with a
// callback that decides what is visible in each half.

import {
  AmbientLight, Color, DirectionalLight, GridHelper, HemisphereLight, Mesh, Object3D,
  PerspectiveCamera, Scene, Vector3, Vector4, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface FlyTarget { target: Vector3; position: Vector3 }
export type CompareSide = 'left' | 'right';

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  /** When set, the view is split and this is called before rendering each half. */
  compareFilter: ((side: CompareSide) => void) | null = null;
  /** Split vertically (top/bottom) instead of left/right. Set for portrait screens. */
  compareStacked = false;
  private body: Object3D | null = null;
  private needsRender = true;
  private fly: { from: FlyTarget; to: FlyTarget; start: number; duration: number } | null = null;
  private readonly floor: GridHelper;
  private width = 1; private height = 1;
  private hemi!: HemisphereLight; private key!: DirectionalLight; private fill!: DirectionalLight; private ambient!: AmbientLight;

  /**
   * 'studio': directional lights that show the shape (placeholder, untextured scans).
   * 'flat': almost no directional light, for photogrammetry textures that already
   * contain the lighting of the room they were shot in.
   */
  setLighting(mode: 'studio' | 'flat'): void {
    const flat = mode === 'flat';
    this.hemi.intensity = flat ? 2.6 : 1.6;
    this.key.intensity = flat ? 0.35 : 1.6;
    this.fill.intensity = flat ? 0.2 : 0.7;
    this.ambient.intensity = flat ? 0.9 : 0.25;
    this.needsRender = true;
  }

  constructor(readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new Color(0x1b1d22);
    this.camera = new PerspectiveCamera(38, 1, 0.02, 50);
    this.camera.position.set(0, 1.1, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 8;
    this.controls.target.set(0, 1.0, 0);
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    this.hemi = new HemisphereLight(0xffffff, 0x6b7280, 1.6);
    this.key = new DirectionalLight(0xffffff, 1.6);
    this.key.position.set(1.5, 3, 2.5);
    this.fill = new DirectionalLight(0xdfe8ff, 0.7);
    this.fill.position.set(-2, 1.5, -1.5);
    this.ambient = new AmbientLight(0xffffff, 0.25);
    this.scene.add(this.hemi, this.key, this.fill, this.ambient);

    this.floor = new GridHelper(4, 16, 0x3a3f4a, 0x2a2e36);
    this.scene.add(this.floor);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  /** Replace the displayed body. */
  setBody(object: Object3D): void {
    if (this.body) this.scene.remove(this.body);
    this.body = object;
    this.scene.add(object);
    this.needsRender = true;
  }

  getBody(): Object3D | null { return this.body; }

  /** All meshes of the current body (for picking). */
  bodyMeshes(): Mesh[] {
    const out: Mesh[] = [];
    this.body?.traverse((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
    return out;
  }

  /** Smoothly move the camera. */
  flyTo(to: FlyTarget, duration = 650): void {
    this.fly = {
      from: { target: this.controls.target.clone(), position: this.camera.position.clone() },
      to: { target: to.target.clone(), position: to.position.clone() },
      start: performance.now(),
      duration,
    };
    this.needsRender = true;
  }

  /** Front view of the whole body of the given height. */
  frameBody(height: number): void {
    const target = new Vector3(0, height * 0.5, 0);
    const dist = (height * 0.62) / Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.viewAspect();
    const aspectFix = aspect < 0.75 ? 1 / aspect * 0.75 : 1;
    this.flyTo({ target, position: new Vector3(0, height * 0.52, dist * aspectFix) });
  }

  requestRender(): void { this.needsRender = true; }

  /** Aspect ratio of one viewport. */
  viewAspect(): number {
    if (!this.compareFilter) return this.width / this.height;
    return this.compareStacked ? this.width / (this.height / 2) : (this.width / 2) / this.height;
  }

  /** Size of the drawing area in CSS pixels. */
  size(): { width: number; height: number } { return { width: this.width, height: this.height }; }

  /** Render now and return the image. */
  async screenshot(type = 'image/png'): Promise<Blob> {
    this.renderFrame();
    return new Promise((resolve, reject) => this.renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('screenshot failed'))), type));
  }

  private resize(): void {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.needsRender = true;
  }

  private renderFrame(): void {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const W = Math.floor(this.width * pr), H = Math.floor(this.height * pr);
    if (!this.compareFilter) {
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      r.render(this.scene, this.camera);
      return;
    }
    r.setScissorTest(true);
    const rects: Record<CompareSide, Vector4> = this.compareStacked
      ? { left: new Vector4(0, Math.ceil(H / 2), W, Math.floor(H / 2)), right: new Vector4(0, 0, W, Math.floor(H / 2)) }
      : { left: new Vector4(0, 0, Math.floor(W / 2), H), right: new Vector4(Math.ceil(W / 2), 0, Math.floor(W / 2), H) };
    this.camera.aspect = this.viewAspect();
    this.camera.updateProjectionMatrix();
    for (const side of ['left', 'right'] as CompareSide[]) {
      const v = rects[side];
      r.setViewport(v); r.setScissor(v);
      this.compareFilter(side);
      r.render(this.scene, this.camera);
    }
    r.setScissorTest(false);
  }

  private tick(now: number): void {
    if (this.fly) {
      const f = this.fly;
      let u = Math.min(1, (now - f.start) / f.duration);
      u = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // ease in-out cubic
      this.camera.position.lerpVectors(f.from.position, f.to.position, u);
      this.controls.target.lerpVectors(f.from.target, f.to.target, u);
      if (u >= 1) this.fly = null;
      this.needsRender = true;
    }
    const moved = this.controls.update();
    if (moved || this.needsRender) {
      this.renderFrame();
      this.needsRender = false;
    }
  }
}
