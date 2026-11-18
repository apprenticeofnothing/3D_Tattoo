// Pointer handling on the 3D canvas. Decides between: tapping (place or
// select), dragging a design along the skin, dragging a handle, and leaving
// the event to the camera controls. One finger on a design moves it; a
// second finger always hands over to the camera.
//
// Two fingers on the camera either pinch (zoom about the spot where they
// first landed) or drag together (pan). Which one is decided once, in the
// first few pixels of movement, and kept until the fingers lift: on a phone
// the point between pinching fingers always drifts, and turning that drift
// into panning made the view slide away while zooming.

export type DragKind = 'move' | 'rotate' | 'scale' | 'joint' | 'spin';

export interface GestureHandlers {
  /** Return which drag to start for a pointer-down at (x, y), or null to let the camera have it. */
  hitTest(x: number, y: number): DragKind | null;
  onTap(x: number, y: number): void;
  onDragStart(kind: DragKind, x: number, y: number): void;
  onDragMove(kind: DragKind, x: number, y: number): void;
  onDragEnd(kind: DragKind, cancelled: boolean): void;
  /** Two fingers that started with one finger on a design: resize (scale factor) and rotate (radians, screen). */
  onPinchStart?(): void;
  onPinchMove?(scale: number, rotation: number): void;
  onPinchEnd?(): void;
  /** Two fingers zooming the view: factor < 1 zooms in, about the screen point where the pinch began. */
  onCameraZoom?(factor: number, anchorX: number, anchorY: number, first: boolean): void;
  /** Two fingers moving together: pan the view by this many pixels. */
  onCameraPan?(dx: number, dy: number): void;
  /** The two-finger camera gesture ended (what it turned out to be). */
  onCameraEnd?(mode: 'zoom' | 'pan' | null): void;
}

export function attachGestures(canvas: HTMLElement, controls: { enabled: boolean }, h: GestureHandlers): void {
  const active = new Map<number, { x: number; y: number }>();
  let primary: { id: number; x: number; y: number; t: number; kind: DragKind | null; dragging: boolean } | null = null;
  let pinch: { a: number; b: number; d0: number; a0: number } | null = null;
  let cam: { a: number; b: number; d0: number; m0: { x: number; y: number }; lastD: number; lastM: { x: number; y: number }; mode: 'zoom' | 'pan' | null; zoomed: boolean } | null = null;
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const geom = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) });

  const endDrag = (cancelled: boolean) => {
    if (primary?.dragging && primary.kind) h.onDragEnd(primary.kind, cancelled);
    controls.enabled = true;
    primary = null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 2 && primary && primary.kind === 'move' && h.onPinchStart) {
      // First finger was on a design: two fingers resize and rotate it.
      if (primary.dragging) h.onDragEnd('move', false);
      const ids = [...active.keys()];
      const g = geom(active.get(ids[0])!, active.get(ids[1])!);
      pinch = { a: ids[0], b: ids[1], d0: Math.max(1, g.d), a0: g.ang };
      primary = null;
      controls.enabled = false;
      canvas.setPointerCapture?.(e.pointerId);
      h.onPinchStart();
      return;
    }
    if (active.size > 1) { // second finger: camera takes over
      if (primary?.dragging) endDrag(true); else primary = null;
      controls.enabled = true;
      if (active.size === 2 && (h.onCameraZoom || h.onCameraPan)) {
        const ids = [...active.keys()], pa = active.get(ids[0])!, pb = active.get(ids[1])!;
        const d = Math.max(1, geom(pa, pb).d), m = mid(pa, pb);
        cam = { a: ids[0], b: ids[1], d0: d, m0: m, lastD: d, lastM: m, mode: null, zoomed: false };
      }
      return;
    }
    const kind = h.hitTest(e.clientX, e.clientY);
    primary = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), kind, dragging: false };
    if (kind) {
      // Claim the pointer before OrbitControls starts rotating.
      controls.enabled = false;
      canvas.setPointerCapture?.(e.pointerId);
    }
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    const a = active.get(e.pointerId);
    if (a) { a.x = e.clientX; a.y = e.clientY; }
    if (pinch) {
      const pa = active.get(pinch.a), pb = active.get(pinch.b);
      if (pa && pb) { const g = geom(pa, pb); h.onPinchMove?.(g.d / pinch.d0, g.ang - pinch.a0); }
      return;
    }
    if (cam) {
      const pa = active.get(cam.a), pb = active.get(cam.b);
      if (!pa || !pb) return;
      const d = Math.max(1, geom(pa, pb).d), m = mid(pa, pb);
      if (!cam.mode) {
        const spread = Math.abs(d - cam.d0), shift = Math.hypot(m.x - cam.m0.x, m.y - cam.m0.y);
        if (spread > 10 && spread >= 0.6 * shift) cam.mode = 'zoom';
        else if (shift > 16) cam.mode = 'pan';
        else return;
      }
      if (cam.mode === 'zoom') {
        h.onCameraZoom?.(cam.lastD / d, cam.m0.x, cam.m0.y, !cam.zoomed);
        cam.zoomed = true;
        cam.lastD = d;
      } else {
        h.onCameraPan?.(m.x - cam.lastM.x, m.y - cam.lastM.y);
        cam.lastM = m;
      }
      return;
    }
    if (!primary || e.pointerId !== primary.id || active.size > 1) return;
    const dx = e.clientX - primary.x, dy = e.clientY - primary.y;
    if (!primary.dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      if (!primary.kind) return; // camera drag
      primary.dragging = true;
      h.onDragStart(primary.kind, primary.x, primary.y);
    }
    h.onDragMove(primary.kind!, e.clientX, e.clientY);
  }, { capture: true });

  const up = (e: PointerEvent) => {
    active.delete(e.pointerId);
    if (cam && (e.pointerId === cam.a || e.pointerId === cam.b)) { h.onCameraEnd?.(cam.mode); cam = null; }
    if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) {
      pinch = null;
      h.onPinchEnd?.();
      controls.enabled = active.size === 0;
      return;
    }
    if (!primary || e.pointerId !== primary.id) return;
    if (primary.dragging) { endDrag(false); return; }
    const moved = Math.hypot(e.clientX - primary.x, e.clientY - primary.y);
    const dt = performance.now() - primary.t;
    const wasTapCandidate = moved < 8 && dt < 600;
    controls.enabled = true;
    primary = null;
    if (wasTapCandidate && e.type === 'pointerup') h.onTap(e.clientX, e.clientY);
  };
  canvas.addEventListener('pointerup', up, { capture: true });
  canvas.addEventListener('pointercancel', (e) => {
    active.delete(e.pointerId);
    if (cam && (e.pointerId === cam.a || e.pointerId === cam.b)) { h.onCameraEnd?.(cam.mode); cam = null; }
    if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) { pinch = null; h.onPinchEnd?.(); controls.enabled = true; return; }
    if (primary && e.pointerId === primary.id) endDrag(true);
  }, { capture: true });
}
