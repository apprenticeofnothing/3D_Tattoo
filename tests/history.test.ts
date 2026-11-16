import { describe, expect, it } from 'vitest';
import { History, type PlacementData } from '../src/app/project';

const p = (id: string, w: number): PlacementData => ({ id, designId: 'd', tri: 0, point: [0, 0, 0], normal: [0, 0, 1], rotation: 0, widthCm: w, mirror: false, wrap: false, opacity: 1, mode: 'stencil', option: 'both' });

describe('History', () => {
  it('undoes and redoes, and drops redo states after a new change', () => {
    const h = new History();
    h.push([]);
    h.push([p('a', 10)]);
    h.push([p('a', 12)]);
    expect(h.canUndo).toBe(true);
    expect(h.undo()![0].widthCm).toBe(10);
    expect(h.undo()).toEqual([]);
    expect(h.canUndo).toBe(false);
    expect(h.redo()![0].widthCm).toBe(10);
    h.push([p('a', 10), p('b', 5)]); // new branch
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toEqual([p('a', 10)]);
  });
  it('ignores a push identical to the current state', () => {
    const h = new History();
    h.push([p('a', 10)]); h.push([p('a', 10)]);
    expect(h.canUndo).toBe(false);
  });
});
