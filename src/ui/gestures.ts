// Pointer handling on the 3D canvas. Decides between: tapping (place or
// select), dragging a design along the skin, dragging a handle, and leaving
// the event to the camera controls. One finger on a design moves it; a
// second finger always hands over to the camera.

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
}

export function attachGestures(canvas: HTMLElement, controls: { enabled: boolean }, h: GestureHandlers): void {
  const active = new Map<number, { x: number; y: number }>();
  let primary: { id: number; x: number; y: number; t: number; kind: DragKind | null; dragging: boolean } | null = null;
  let pinch: { a: number; b: number; d0: number; a0: number } | null = null;
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
    if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) { pinch = null; h.onPinchEnd?.(); controls.enabled = true; return; }
    if (primary && e.pointerId === primary.id) endDrag(true);
  }, { capture: true });
}
