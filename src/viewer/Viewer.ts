// Three.js scene, camera, controls and render loop. Renders only when
// something changed, which keeps a phone cool and the battery alive.
// Supports a split "compare" view: two viewports, same camera, with a
// callback that decides what is visible in each half.

import {
  AmbientLight, Color, DirectionalLight, GridHelper, HemisphereLight, Mesh, Object3D,
  PerspectiveCamera, Quaternion, Scene, TOUCH, Vector3, Vector4, WebGLRenderer,
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
  /** Called after every rendered frame (for HTML overlays that follow the scene). */
  onAfterRender: (() => void) | null = null;
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
  private bounds: { min: Vector3; max: Vector3 } | null = null;
  /** The whole-body view the camera is in (side and body height), until the view is moved by hand. */
  private home: { yaw: number; height: number } | null = null;
  /** Furthest the camera may be from what it looks at: a little beyond the whole-body view. */
  private maxOut = Viewer.MAX_ZOOM_OUT;
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
    this.controls.zoomToCursor = true;
    // Two fingers are handled by the app (pinch to zoom about where the
    // fingers landed, or drag to pan; never both at once), not here.
    this.controls.touches = { ONE: TOUCH.ROTATE, TWO: -1 as unknown as TOUCH };
    // Look down at the shoulders (up to 75 degrees) or up from below (45),
    // never over the top of the head or from right underneath.
    this.controls.minPolarAngle = (15 * Math.PI) / 180;
    this.controls.maxPolarAngle = (135 * Math.PI) / 180;
    // Turning the view by hand ends "whole body" framing (it then stays put on resize).
    let startPos: Vector3 | null = null;
    this.controls.addEventListener('start', () => { startPos = this.camera.position.clone(); });
    this.controls.addEventListener('end', () => { if (startPos && startPos.distanceToSquared(this.camera.position) > 1e-8) this.home = null; startPos = null; });
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
    this.home = null;
    const from = this.zoomGoal ?? { camera: this.camera.position.clone(), target: this.controls.target.clone() };
    const r = zoomTowards(from.camera, from.target, anchor, factor, Viewer.MIN_DIST, this.maxOut);
    // Slide the orbit target along the line of sight to the depth of the
    // zoomed spot: the view is unchanged, orbiting then pivots around that
    // spot, and the orbit control's minimum distance never fights the zoom.
    const dir = r.target.clone().sub(r.camera).normalize();
    const depth = Math.max(Viewer.MIN_DIST * 1.05, anchor.clone().sub(r.camera).dot(dir));
    const target = r.camera.clone().addScaledVector(dir, depth);
    this.zoomGoal = { camera: r.camera, target };
    // Zooming towards empty space must not carry the turning point off the body.
    if (this.bounds) {
      const c = target.clone().clamp(this.bounds.min, this.bounds.max), d = c.sub(target);
      if (d.lengthSq() > 1e-12) { this.zoomGoal.target.add(d); this.zoomGoal.camera.add(d); }
    }
    this.needsRender = true;
  }

  /** Keep the point the view turns around within this box (the body, with a margin). */
  setBounds(min: Vector3, max: Vector3): void {
    this.bounds = { min: min.clone(), max: max.clone() };
    this.clampTarget();
  }

  /** Move the camera and its target together so the target stays in the bounds. */
  private clampTarget(): void {
    if (!this.bounds) return;
    const t = this.controls.target, c = t.clone().clamp(this.bounds.min, this.bounds.max);
    if (c.distanceToSquared(t) < 1e-12) return;
    const d = c.sub(t);
    t.add(d); this.camera.position.add(d);
    if (this.zoomGoal) { this.zoomGoal.target.add(d); this.zoomGoal.camera.add(d); }
    this.needsRender = true;
  }

  /** Slide the view by a screen distance (two-finger drag): the body follows the fingers. */
  panBy(dxPx: number, dyPx: number): void {
    this.fly = null;
    this.home = null;
    if (this.zoomGoal) { this.camera.position.copy(this.zoomGoal.camera); this.controls.target.copy(this.zoomGoal.target); this.zoomGoal = null; }
    const cam = this.camera, tgt = this.controls.target;
    cam.updateMatrixWorld();
    const mpp = this.metresPerPixel(cam.position.distanceTo(tgt));
    const right = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const shift = right.multiplyScalar(-dxPx * mpp).addScaledVector(up, dyPx * mpp);
    cam.position.add(shift); tgt.add(shift);
    this.clampTarget();
    this.controls.update();
    this.needsRender = true;
  }

  /** True when no zoom glide or camera flight is in progress. */
  isSettled(): boolean { return !this.zoomGoal && !this.fly; }

  /** Distance from the camera to its orbit target (for tests and UI). */
  zoomDistance(): number { return this.camera.position.distanceTo(this.controls.target); }

  /** Smoothly move the camera. */
  flyTo(to: FlyTarget, duration = 650): void {
    this.zoomGoal = null;
    this.home = null;
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
    this.home = null;
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
        // Same range as turning with a finger: 75 degrees looking down, 45 looking up.
        const want = Math.min((75 * Math.PI) / 180, Math.max((-45 * Math.PI) / 180, elev + dPitch));
        const q = new Quaternion().setFromAxisAngle(right, -(want - elev));
        cam.sub(center).applyQuaternion(q).add(center);
        tgt.sub(center).applyQuaternion(q).add(center);
      }
    }
    this.controls.update();
    this.needsRender = true;
  }

  /** Whole-body view from a side: 0 front, 90 the body's left, 180 back, 270 right. */
  viewFrom(yawDeg: number, height: number, animate = true): void {
    const target = new Vector3(0, height * 0.5, 0);
    // With a bottom panel the vertical field of view is spread over a taller
    // virtual frame; back off so the whole body fits in the uncovered part.
    const b = this.compareFilter ? 0 : this.inset.bottom;
    const vFactor = (this.height + b) / Math.max(1, this.height - b);
    const dist = ((height * 0.62) / Math.tan((this.camera.fov * Math.PI) / 360)) * vFactor;
    const aspect = this.viewAspect();
    const aspectFix = aspect < 0.75 ? 1 / aspect * 0.75 : 1;
    const a = (yawDeg * Math.PI) / 180;
    const r = dist * aspectFix;
    const position = new Vector3(Math.sin(a) * r, height * 0.52, Math.cos(a) * r);
    // Zooming out stops a little beyond this view: the body never shrinks to a speck.
    this.maxOut = Math.max(1, position.distanceTo(target) * 1.6);
    this.controls.maxDistance = this.maxOut;
    if (animate) this.flyTo({ target, position });
    else {
      this.fly = null; this.zoomGoal = null;
      this.camera.position.copy(position); this.controls.target.copy(target);
      this.controls.update();
      this.needsRender = true;
    }
    this.home = { yaw: yawDeg, height };
  }

  /** Front view of the whole body of the given height. */
  frameBody(height: number): void { this.viewFrom(0, height); }

  /** Make the view turn around this point (on the line of sight: the picture does not change). */
  setPivot(p: Vector3): void {
    this.controls.target.copy(p);
    this.controls.update();
    this.needsRender = true;
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

  /** Metres per screen pixel at a given distance in front of the camera. */
  metresPerPixel(depth: number): number {
    const span = this.compareFilter ? this.height : this.height + this.inset.bottom;
    return (2 * depth * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, span);
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

  /**
   * One picture from another camera position, without moving the view the
   * person sees (the camera is put back before the next frame is shown).
   */
  async snapshotFrom(position: Vector3, target: Vector3, type = 'image/png'): Promise<Blob> {
    const cam = this.camera, pos = cam.position.clone(), quat = cam.quaternion.clone(), inset = this.inset;
    cam.position.copy(position); cam.lookAt(target); cam.updateMatrixWorld();
    this.inset = { right: 0, bottom: 0 };
    let shot: Promise<Blob>;
    try {
      this.renderFrame();
      // toBlob copies the pixels straight away; the encoding finishes later.
      shot = new Promise((resolve, reject) => this.renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('snapshot failed'))), type));
    } finally {
      cam.position.copy(pos); cam.quaternion.copy(quat); cam.updateMatrixWorld();
      this.inset = inset;
      this.needsRender = true;
    }
    return shot;
  }

  private resize(): void {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.needsRender = true;
    // Still showing the whole body: fit it to the new size (phone toolbars
    // appearing, the phone turned), instead of leaving it cut off or tiny.
    if (this.home) this.viewFrom(this.home.yaw, this.home.height, false);
  }

  private renderFrame(): void {
    const r = this.renderer;
    // Viewport and scissor rectangles are in CSS pixels: the renderer applies
    // the device pixel ratio itself. (Passing device pixels drew the scene
    // 2-3x too large on high-density screens: iPhones, Retina Macs.)
    const W = this.width, H = this.height;
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
    if (!this.fly) this.clampTarget(); // a mouse pan (right button) stays on the body too
    if (moved || this.needsRender) {
      this.renderFrame();
      this.needsRender = false;
      this.onAfterRender?.();
    }
  }
}
