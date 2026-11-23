import { describe, expect, it } from 'vitest';
import { poseAt } from '../src/core/poseTrack';

const yaw = (deg: number, x: number, t: number) => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // Rotation about y, column-major.
  return { t, m: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 1.5, 0, 1] };
};

describe('pose between head-pose samples', () => {
  it('interpolates position and rotation, and reports the turn rate', () => {
    const track = [yaw(0, 0, 0), yaw(1.2, 0.012, 0.0125), yaw(2.4, 0.024, 0.025), yaw(3.6, 0.036, 0.0375)];
    const p = poseAt(track, 0.019)!;
    const ang = (Math.atan2(-p.m[2], p.m[0]) * 180) / Math.PI;
    expect(ang).toBeCloseTo(1.824, 2);
    expect(p.m[12]).toBeCloseTo(0.01824, 4);
    expect(p.turnDegPerS).toBeCloseTo(96, 0);
    expect(poseAt(track, 1)).toBeNull();
  });
});
