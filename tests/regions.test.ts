import { describe, expect, it } from 'vitest';
import { buildMannequin } from '../src/body/mannequin';
import { REGIONS, locateRegion } from '../src/body/regions';

describe('regions on the mannequin', () => {
  const H = 1.93;
  const mesh = buildMannequin({ height: H, cell: 0.0125 });
  const byId = (id: string) => REGIONS.find((r) => r.id === id)!;

  it('finds every region', () => {
    for (const r of REGIONS) expect(locateRegion(r, mesh.positions, H), r.id).not.toBeNull();
  });

  it('puts left regions at +x and right regions at -x', () => {
    expect(locateRegion(byId('forearm-outer-left'), mesh.positions, H)!.target.x).toBeGreaterThan(0.15);
    expect(locateRegion(byId('forearm-outer-right'), mesh.positions, H)!.target.x).toBeLessThan(-0.15);
    const thigh = locateRegion(byId('thigh-front-left'), mesh.positions, H)!.target;
    expect(thigh.x).toBeGreaterThan(0.03);
    expect(thigh.x).toBeLessThan(0.16); // on the thigh, not pulled toward the hand
  });

  it('puts chest in front of the body and back behind it', () => {
    expect(locateRegion(byId('chest'), mesh.positions, H)!.target.z).toBeGreaterThan(0.03);
    expect(locateRegion(byId('upper-back'), mesh.positions, H)!.target.z).toBeLessThan(-0.03);
    const chest = locateRegion(byId('chest'), mesh.positions, H)!;
    expect(chest.target.y / H).toBeGreaterThan(0.68);
    expect(chest.target.y / H).toBeLessThan(0.81);
    expect(chest.position.z).toBeGreaterThan(chest.target.z + 0.5);
  });
});
