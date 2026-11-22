type PP = { x: number; y: number; z: number };
import { estimateAxis } from './structure';

const IN = 0.0254;

/**
 * The scanned points as an ASCII PLY in meters, z up, floor at 0 and turned so
 * the room's walls run along x and y. That is the input layout point-cloud
 * room models (SpatialLM and similar) expect.
 */
export function exportPly(pts: PP[], floorZ = 0): string {
  const axis = pts.length ? estimateAxis(pts) : 0;
  const c = Math.cos(-axis);
  const s = Math.sin(-axis);
  const lines = [
    'ply',
    'format ascii 1.0',
    'comment basement-planner scan, meters, z up',
    `element vertex ${pts.length}`,
    'property float x',
    'property float y',
    'property float z',
    'end_header',
  ];
  for (const p of pts) {
    const x = (p.x * c - p.y * s) * IN;
    const y = -(p.x * s + p.y * c) * IN; // plan y runs south; flip for a right-handed z-up frame
    lines.push(`${x.toFixed(4)} ${y.toFixed(4)} ${((p.z - floorZ) * IN).toFixed(4)}`);
  }
  return lines.join('\n') + '\n';
}
