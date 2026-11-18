// Three.js scene, camera, controls and render loop. Renders only when
// something changed, which keeps a phone cool and the battery alive.
// Supports a split "compare" view: two viewports, same camera, with a
// callback that decides what is visible in each half.

import {
  AmbientLight, Color, DirectionalLight, GridHelper, HemisphereLight, Mesh, Object3D,
  PerspectiveCamera, Quaternion, Scene, Vector3, Vector4, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { zoomTowards } from './zoom';

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
  private zoomGoal: { camera: Vector3; target: Vector3 } | null = null;
  static readonly MIN_DIST = 0.07;
  /** Orbit limit (large, so a phone's bottom sheet can still frame the whole body). */
  static readonly MAX_DIST = 25;
  /** How far wheel, pinch and buttons may zoom out. */
  static readonly MAX_ZOOM_OUT = 10;
  private readonly floor: GridHelper;
  private width = 1; private height = 1;
  /** Screen space covered by side or bottom panels; the view is centred in what remains. */
  private inset = { right: 0, bottom: 0 };
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
    this.camera = new PerspectiveCamera(38, 1, 0.02, 80);
    this.camera.position.set(0, 1.1, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = Viewer.MIN_DIST;
    this.controls.maxDistance = Viewer.MAX_DIST;
    // Pinch on a phone zooms towards the point between the fingers.
    this.controls.zoomToCursor = true;
    this.controls.target.set(0, 1.0, 0);
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    this.hemi = new HemisphereLight(0xffffff, 0x6b7280, 1.6);
    // Key and fill lights travel with the camera, so a body turned to any
    // side is lit the same way, as if it were turning in a studio.
    this.key = new DirectionalLight(0xffffff, 1.6);
    this.key.position.set(1.4, 1.6, 1.2);
    this.fill = new DirectionalLight(0xdfe8ff, 0.7);
    this.fill.position.set(-1.8, 0.4, 0.6);
    const aim = new Object3D();
    aim.position.set(0, 0, -3);
    this.camera.add(this.key, this.fill, aim);
    this.key.target = aim; this.fill.target = aim;
    this.ambient = new AmbientLight(0xffffff, 0.25);
    this.scene.add(this.camera, this.hemi, this.ambient);

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

  /**
   * Zoom towards `anchor` (a point on the body under the cursor): factor < 1
   * zooms in. Successive calls accumulate and the camera glides there, so a
   * mouse wheel feels smooth and a trackpad pinch stays responsive.
   */
  zoomAt(anchor: Vector3, factor: number): void {
    this.fly = null;
    const from = this.zoomGoal ?? { camera: this.camera.position.clone(), target: this.controls.target.clone() };
    const r = zoomTowards(from.camera, from.target, anchor, factor, Viewer.MIN_DIST, Viewer.MAX_ZOOM_OUT);
    // Slide the orbit target along the line of sight to the depth of the
    // zoomed spot: the view is unchanged, orbiting then pivots around that
    // spot, and the orbit control's minimum distance never fights the zoom.
    const dir = r.target.clone().sub(r.camera).normalize();
    const depth = Math.max(Viewer.MIN_DIST * 1.05, anchor.clone().sub(r.camera).dot(dir));
    const target = r.camera.clone().addScaledVector(dir, depth);
    this.zoomGoal = { camera: r.camera, target };
    this.needsRender = true;
  }

  /** True when no zoom glide or camera flight is in progress. */
  isSettled(): boolean { return !this.zoomGoal && !this.fly; }

  /** Distance from the camera to its orbit target (for tests and UI). */
  zoomDistance(): number { return this.camera.position.distanceTo(this.controls.target); }

  /** Smoothly move the camera. */
  flyTo(to: FlyTarget, duration = 650): void {
    this.zoomGoal = null;
    this.fly = {
      from: { target: this.controls.target.clone(), position: this.camera.position.clone() },
      to: { target: to.target.clone(), position: to.position.clone() },
      start: performance.now(),
      duration,
    };
    this.needsRender = true;
  }

  /**
   * Turn the body in front of the camera: the camera and its target swing
   * around the body's vertical axis (yaw) and tilt around a horizontal axis
   * through `center` (pitch, kept within +-80 degrees). Lights move with the
   * camera, so it looks and feels like turning the body itself.
   */
  spin(dYaw: number, dPitch: number, center: Vector3): void {
    this.fly = null;
    if (this.zoomGoal) { this.camera.position.copy(this.zoomGoal.camera); this.controls.target.copy(this.zoomGoal.target); this.zoomGoal = null; }
    const cam = this.camera.position, tgt = this.controls.target;
    if (dYaw) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), dYaw);
      cam.sub(center).applyQuaternion(q).add(center);
      tgt.sub(center).applyQuaternion(q).add(center);
    }
    if (dPitch) {
      const off = cam.clone().sub(center);
      const right = new Vector3().crossVectors(new Vector3(0, 1, 0), off).normalize();
      if (right.lengthSq() > 0) {
        const elev = Math.asin(Math.min(1, Math.max(-1, off.y / off.length())));
        const limit = (80 * Math.PI) / 180;
        const want = Math.min(limit, Math.max(-limit, elev + dPitch));
        const q = new Quaternion().setFromAxisAngle(right, -(want - elev));
        cam.sub(center).applyQuaternion(q).add(center);
        tgt.sub(center).applyQuaternion(q).add(center);
      }
    }
    this.controls.update();
    this.needsRender = true;
  }

  /** Whole-body view from a side: 0 front, 90 the body's left, 180 back, 270 right. */
  viewFrom(yawDeg: number, height: number): void {
    const target = new Vector3(0, height * 0.5, 0);
    const b = this.compareFilter ? 0 : this.inset.bottom;
    const vFactor = (this.height + b) / Math.max(1, this.height - b);
    const dist = ((height * 0.62) / Math.tan((this.camera.fov * Math.PI) / 360)) * vFactor;
    const aspect = this.viewAspect();
    const aspectFix = aspect < 0.75 ? 1 / aspect * 0.75 : 1;
    const a = (yawDeg * Math.PI) / 180;
    const r = dist * aspectFix;
    this.flyTo({ target, position: new Vector3(Math.sin(a) * r, height * 0.52, Math.cos(a) * r) });
  }

  /** Front view of the whole body of the given height. */
  frameBody(height: number): void {
    const target = new Vector3(0, height * 0.5, 0);
    // With a bottom panel the vertical field of view is spread over a taller
    // virtual frame; back off so the whole body fits in the uncovered part.
    const b = this.compareFilter ? 0 : this.inset.bottom;
    const vFactor = (this.height + b) / Math.max(1, this.height - b);
    const dist = ((height * 0.62) / Math.tan((this.camera.fov * Math.PI) / 360)) * vFactor;
    const aspect = this.viewAspect();
    const aspectFix = aspect < 0.75 ? 1 / aspect * 0.75 : 1;
    this.flyTo({ target, position: new Vector3(0, height * 0.52, dist * aspectFix) });
  }

  requestRender(): void { this.needsRender = true; }

  /** Keep the scene centred in the part of the canvas not covered by a panel. */
  setInsets(inset: { right?: number; bottom?: number }): void {
    this.inset = { right: Math.max(0, inset.right ?? 0), bottom: Math.max(0, inset.bottom ?? 0) };
    this.needsRender = true;
  }

  /**
   * Factor by which screen-sized sprites appear enlarged because of the
   * panel view offset (the visible window is part of a larger virtual frame).
   * Divide a sprite's scale by this to keep a constant size in pixels.
   */
  spriteMagnification(): number {
    if (this.compareFilter) return 1;
    return (this.height + this.inset.bottom) / this.height;
  }

  /** Aspect ratio of one viewport. */
  viewAspect(): number {
    if (!this.compareFilter) return Math.max(1, this.width - this.inset.right) / Math.max(1, this.height - this.inset.bottom);
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
      const { right, bottom } = this.inset;
      if (right > 0 || bottom > 0) {
        // A larger virtual frame whose centre is the centre of the uncovered area.
        const fw = this.width + right, fh = this.height + bottom;
        this.camera.aspect = fw / fh;
        this.camera.setViewOffset(fw, fh, right, bottom, this.width, this.height);
      } else {
        this.camera.clearViewOffset();
        this.camera.aspect = this.width / this.height;
      }
      this.camera.updateProjectionMatrix();
      r.render(this.scene, this.camera);
      return;
    }
    this.camera.clearViewOffset();
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
    if (this.zoomGoal) {
      const g = this.zoomGoal;
      this.camera.position.lerp(g.camera, 0.35);
      this.controls.target.lerp(g.target, 0.35);
      if (this.camera.position.distanceToSquared(g.camera) < 1e-10 && this.controls.target.distanceToSquared(g.target) < 1e-10) {
        this.camera.position.copy(g.camera); this.controls.target.copy(g.target); this.zoomGoal = null;
      }
      this.needsRender = true;
    }
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
