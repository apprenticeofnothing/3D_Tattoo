import { describe, expect, it } from 'vitest';
import { describeHint, LM, suggestFromPose, type Landmark } from '../src/existing/poseSuggest';

const W = 1000, H = 1500;
/**
 * A standing person facing the camera (the person's left on the photo's
 * right), arms hanging. `back` turns them around. Photo pixels and world
 * metres (x right, y down, z away from the camera, like MediaPipe).
 */
function person(back = false): { lm: Landmark[]; world: Landmark[] } {
  const px: Record<number, [number, number]> = {
    [LM.nose]: [500, 200],
    [LM.lShoulder]: [620, 350], [LM.rShoulder]: [380, 350],
    [LM.lElbow]: [660, 600], [LM.rElbow]: [340, 600],
    [LM.lWrist]: [680, 820], [LM.rWrist]: [320, 820],
    [LM.lIndex]: [690, 900], [LM.rIndex]: [310, 900], [LM.lPinky]: [670, 900], [LM.rPinky]: [330, 900],
    [LM.lHip]: [570, 800], [LM.rHip]: [430, 800],
    [LM.lKnee]: [570, 1100], [LM.rKnee]: [430, 1100],
    [LM.lAnkle]: [570, 1400], [LM.rAnkle]: [430, 1400],
    [LM.lFoot]: [580, 1450], [LM.rFoot]: [420, 1450],
  };
  const lm: Landmark[] = [], world: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    let [x, y] = px[i] ?? [500, 200];
    if (back) {
      // Seen from behind: the same body, but the person's left is now on the photo's left.
      const mirrorOf = i >= 11 ? (i % 2 ? i + 1 : i - 1) : i;
      [x, y] = px[mirrorOf] ?? [500, 200];
    }
    lm.push({ x: x / W, y: y / H, z: 0, visibility: 0.99 });
    world.push({ x: (x - 500) / 1000, y: (y - 800) / 1000, z: 0, visibility: 0.99 });
  }
  return { lm, world };
}

describe('placement suggestion from pose landmarks', () => {
  it('finds the left forearm and how far along it, seen from the front', () => {
    const { lm, world } = person();
    // 40% from the left elbow (660,600) to the left wrist (680,820).
    const h = suggestFromPose({ landmarks: lm, world, width: W, height: H, at: { x: 668, y: 688 } })!;
    expect(h.part).toBe('forearm');
    expect(h.side).toBe('left');
    expect(h.t).toBeCloseTo(0.4, 1);
    expect(h.view[2]).toBeGreaterThan(0.95); // camera in front
    expect(describeHint(h)).toBe('left forearm, 40% of the way from elbow to wrist, seen from the front');
  });

  it('turns an offset across the limb into a direction around it', () => {
    const { lm, world } = person();
    // Right of the forearm's centre line in the photo = towards the person's left (outer side of the left arm).
    const h = suggestFromPose({ landmarks: lm, world, width: W, height: H, at: { x: 668 + 25, y: 688 } })!;
    expect(h.part).toBe('forearm');
    expect(h.surfaceDir[0]).toBeGreaterThan(0.3);
    expect(h.surfaceDir[2]).toBeGreaterThan(0.3);
  });

  it('knows a photo of the back', () => {
    const { lm, world } = person(true);
    // The person's left forearm now appears on the photo's left.
    const h = suggestFromPose({ landmarks: lm, world: world.map((l) => ({ ...l, z: 0 })), width: W, height: H, at: { x: 1000 - 668, y: 688 } })!;
    expect(h.part).toBe('forearm');
    expect(h.side).toBe('left');
    expect(h.view[2]).toBeLessThan(-0.95);
    expect(describeHint(h)).toContain('seen from the back');
  });

  it('swaps left and right for a photo taken in a mirror', () => {
    const { lm, world } = person();
    // In a mirror the apparent person's right forearm is really the left one.
    const at = { x: 1000 - 668, y: 688 };
    expect(suggestFromPose({ landmarks: lm, world, width: W, height: H, at })!.side).toBe('right');
    const m = suggestFromPose({ landmarks: lm, world, width: W, height: H, at, mirrored: true })!;
    expect(m.side).toBe('left');
    expect(m.part).toBe('forearm');
    expect(m.view[2]).toBeGreaterThan(0.95);
  });

  it('places a chest tattoo on the torso with its position across and down', () => {
    const { lm, world } = person();
    const h = suggestFromPose({ landmarks: lm, world, width: W, height: H, at: { x: 560, y: 450 } })!;
    expect(h.part).toBe('torso');
    expect(h.t).toBeCloseTo(100 / 450, 1); // down from the shoulder line towards the hips
    expect(h.u!).toBeGreaterThan(0.6); // towards the person's left
    expect(h.pxPerHeight!).toBeCloseTo(1050 / 0.77, -1);
  });
});
