// Project data: what gets saved, reloaded and undone. Designs are stored by
// source (SVG text or bitmap data URL) so a saved file is self-contained.
// Never contains the body mesh.

export type Option = 'A' | 'B' | 'both';
export type ViewMode = 'stencil' | 'inked' | 'heatmap';

export interface DesignSource {
  id: string;
  kind: 'svg' | 'bitmap';
  name: string;
  /** SVG text, or a data URL for bitmaps. */
  data: string;
}

export interface PlacementData {
  id: string;
  designId: string;
  tri: number;
  point: [number, number, number];
  normal: [number, number, number];
  rotation: number;
  widthCm: number;
  mirror: boolean;
  wrap: boolean;
  opacity: number;
  mode: ViewMode;
  option: Option;
  /** Temporarily hidden (still saved). */
  hidden?: boolean;
  /** Barycentric position of the anchor in its triangle. With an unchanged mesh
   *  connectivity (the body builder) this pins the design to the same spot on
   *  the skin whatever the body shape. */
  bary?: [number, number, number];
}

export interface ProjectData {
  version: 1;
  savedAt: string;
  heightCm: number;
  body: {
    label: string;
    triangles: number;
    /** Mesh connectivity family; equal topology means triangle ids and barycentric anchors carry over. */
    topology?: string;
    /** Body builder settings, when the body was built with sliders. */
    builder?: { params: import('../body/builder').BodyParams; appearance: import('../body/builder').Appearance; presetId: string | null };
  };
  designs: DesignSource[];
  placements: PlacementData[];
  selectedId: string | null;
}

/** Undo/redo over snapshots of the placement list. */
export class History {
  private stack: string[] = [];
  private index = -1;
  constructor(private readonly limit = 100) {}

  /** Record a new state (drops any redo states). */
  push(placements: PlacementData[]): void {
    const snap = JSON.stringify(placements);
    if (this.index >= 0 && this.stack[this.index] === snap) return;
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }
  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.stack.length - 1; }
  undo(): PlacementData[] | null {
    if (!this.canUndo) return null;
    this.index--;
    return JSON.parse(this.stack[this.index]);
  }
  redo(): PlacementData[] | null {
    if (!this.canRedo) return null;
    this.index++;
    return JSON.parse(this.stack[this.index]);
  }
  current(): PlacementData[] | null { return this.index >= 0 ? JSON.parse(this.stack[this.index]) : null; }
  /** Overwrite the current state without adding an undo step (e.g. after a body change moved the anchors). */
  replaceCurrent(placements: PlacementData[]): void {
    if (this.index < 0) { this.push(placements); return; }
    this.stack[this.index] = JSON.stringify(placements);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
