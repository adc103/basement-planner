import { INCH_M } from './units.js';
import type { Vec2 } from './geom2d.js';

/**
 * Rigid 2D transform from plan space (inches) to the XR session's floor
 * space (meters, as an (X, Z) pair). World = R(theta) * (plan * INCH_M) + t.
 */
export interface PlanTransform {
  theta: number;
  tx: number;
  tz: number;
}

export const IDENTITY: PlanTransform = { theta: 0, tx: 0, tz: 0 };

export function planToWorld(t: PlanTransform, p: Vec2): { x: number; z: number } {
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  const x = p.x * INCH_M;
  const y = p.y * INCH_M;
  return { x: c * x - s * y + t.tx, z: s * x + c * y + t.tz };
}

export function worldToPlan(t: PlanTransform, w: { x: number; z: number }): Vec2 {
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  const dx = w.x - t.tx;
  const dz = w.z - t.tz;
  return { x: (c * dx + s * dz) / INCH_M, y: (-s * dx + c * dz) / INCH_M };
}

export interface AlignmentSolution {
  transform: PlanTransform;
  /** Difference between the measured and the recorded corner spacing, inches (+ = measured longer). */
  spanError: number;
  /** Largest residual at either corner after the fit, inches. */
  residual: number;
}

/**
 * Solve the plan->world transform from two reference corners.
 * r1/r2 are recorded plan points, w1/w2 the same corners clicked this session.
 * The translation is centered on the midpoint so any span error is split
 * evenly between both corners.
 */
export function solveTwoPoint(
  r1: Vec2,
  r2: Vec2,
  w1: { x: number; z: number },
  w2: { x: number; z: number },
): AlignmentSolution | null {
  const rdx = (r2.x - r1.x) * INCH_M;
  const rdy = (r2.y - r1.y) * INCH_M;
  const wdx = w2.x - w1.x;
  const wdz = w2.z - w1.z;
  const rl = Math.hypot(rdx, rdy);
  const wl = Math.hypot(wdx, wdz);
  if (rl < 0.1 || wl < 0.1) return null; // corners too close together to be useful
  const theta = Math.atan2(wdz, wdx) - Math.atan2(rdy, rdx);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const rmx = ((r1.x + r2.x) / 2) * INCH_M;
  const rmy = ((r1.y + r2.y) / 2) * INCH_M;
  const wmx = (w1.x + w2.x) / 2;
  const wmz = (w1.z + w2.z) / 2;
  const transform: PlanTransform = {
    theta,
    tx: wmx - (c * rmx - s * rmy),
    tz: wmz - (s * rmx + c * rmy),
  };
  const p1 = planToWorld(transform, r1);
  const p2 = planToWorld(transform, r2);
  const residual =
    Math.max(Math.hypot(p1.x - w1.x, p1.z - w1.z), Math.hypot(p2.x - w2.x, p2.z - w2.z)) / INCH_M;
  return { transform, spanError: (wl - rl) / INCH_M, residual };
}
