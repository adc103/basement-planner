import type { SurfaceIndex } from './fit.js';
import type { Vec2 } from './geom2d.js';

/** A wall as the opening finder needs it (plan inches; z0 = floor under the wall). */
export interface OpeningWall {
  a: Vec2;
  b: Vec2;
  thickness: number;
  height: number;
  z0?: number;
}

export interface FoundOpening {
  /** Center, from the wall's a end (inches). */
  offset: number;
  width: number;
  height: number;
  /** Bottom above the floor (0 for a door). */
  sill: number;
  type: 'door' | 'window';
  /** Sides measured on their jamb faces (2 = both). */
  jambs: number;
  /** The head (top) was seen; otherwise height is a standard guess. */
  headSeen: boolean;
}

const BAND = 2.5; // inches either side of a face that count as on it
const LOW = 6; // inches above the floor: below this, base trim and floor noise
const MIN_W = 18;
const MAX_W = 120;

function median(v: number[]): number {
  const s = [...v].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/**
 * The doorway or window in a wall near a spot along it (at, and the height atZ you
 * point through it at), measured on the room mesh:
 * the gap where neither face of the wall shows (an open doorway), its sides from the
 * jamb faces
 * (which face into the opening), its top from the head, its bottom from what
 * stands below it. Null when there is no gap there.
 */
export function findOpening(idx: SurfaceIndex, w: OpeningWall, at: number, atZ = 45): FoundOpening | null {
  const { a, b } = w;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < MIN_W) return null;
  const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const n = { x: -d.y, y: d.x };
  const half = w.thickness / 2;
  const z0 = w.z0 ?? 0;
  const { pos, nrm } = idx.s;
  const face: Array<{ t: number; z: number }> = [];
  const jamb: Array<{ t: number; z: number; dir: number }> = [];
  const head: Array<{ t: number; z: number }> = [];
  const sillTop: Array<{ t: number; z: number }> = [];
  for (const i of idx.near(a, b, half + BAND + 1)) {
    const k = i * 3;
    const t = (pos[k] - a.x) * d.x + (pos[k + 1] - a.y) * d.y;
    if (t < 0 || t > L) continue;
    const u = (pos[k] - a.x) * n.x + (pos[k + 1] - a.y) * n.y;
    const z = pos[k + 2] - z0;
    if (z < 0 || z > w.height + 2) continue;
    const nz = nrm[k + 2];
    if (nz < -0.7 && Math.abs(u) < half + 1.5) {
      head.push({ t, z }); // underside of a head or sill-less top
      continue;
    }
    if (nz > 0.7 && Math.abs(u) < half + 1.5 && z > LOW) {
      sillTop.push({ t, z }); // top of a sill
      continue;
    }
    if (Math.abs(nz) > 0.5) continue;
    const na = nrm[k] * d.x + nrm[k + 1] * d.y;
    const nn = nrm[k] * n.x + nrm[k + 1] * n.y;
    if (Math.abs(na) > 0.7 && Math.abs(u) < Math.max(0.75, half - 0.75)) jamb.push({ t, z, dir: Math.sign(na) });
    else if (Math.abs(na) > 0.7) continue;
    else if (Math.abs(nn) > 0.7) {
      // Which face it looks like (by the way it faces), and how far in front of it. Set
      // back into the frame is a closed door's slab: still solid here (a closed door
      // can't be measured: its jambs are hidden), so it isn't mistaken for a gap.
      const side = Math.sign(nn);
      const ahead = (u - side * half) * side;
      if (ahead > -(2 * half + 1) && ahead < BAND) face.push({ t, z });
    }
  }

  // 1" columns along the wall: wall where a face shows in 2+ of the three 6" bands
  // around the height you point at (inside the opening, for a door or a window).
  const zc = Math.max(LOW + 18, Math.min(w.height - 12, atZ));
  const cols = Math.ceil(L);
  const bands = new Uint8Array(cols * 3);
  for (const p of face) {
    if (p.z < zc - 9 || p.z >= zc + 9) continue;
    const c = Math.min(cols - 1, Math.floor(p.t));
    bands[c * 3 + Math.min(2, Math.floor((p.z - zc + 9) / 6))] = 1;
  }
  const solid = new Uint8Array(cols);
  for (let c = 0; c < cols; c++) solid[c] = bands[c * 3] + bands[c * 3 + 1] + bands[c * 3 + 2] >= 2 ? 1 : 0;
  // The gap at the spot, or the nearest one within 2' of it.
  const start = Math.max(0, Math.min(cols - 1, Math.round(at)));
  let seed = -1;
  for (let r = 0; r <= 24 && seed < 0; r++) {
    for (const c of [start - r, start + r]) {
      if (c >= 0 && c < cols && !solid[c]) {
        seed = c;
        break;
      }
    }
  }
  if (seed < 0) return null;
  // Grow over empty columns; a lone solid column (a stray point) doesn't end it.
  const empty = (c: number) => c >= 0 && c < cols && (!solid[c] || (!solid[c - 1] && !solid[c + 1]));
  let lo = seed;
  let hi = seed;
  while (empty(lo - 1)) lo--;
  while (empty(hi + 1)) hi++;
  // An unseen stretch reaching a wall end isn't a doorway we can measure.
  if (lo <= 0 || hi >= cols - 1) return null;
  let left = lo;
  let right = hi + 1;

  // Sides: the jamb faces, which face into the opening.
  let jambs = 0;
  const jl = jamb.filter((p) => p.dir > 0 && Math.abs(p.t - left) < 4 && Math.abs(p.z - zc) < 18).map((p) => p.t);
  const jr = jamb.filter((p) => p.dir < 0 && Math.abs(p.t - right) < 4 && Math.abs(p.z - zc) < 18).map((p) => p.t);
  if (jl.length >= 6) {
    left = median(jl);
    jambs++;
  }
  if (jr.length >= 6) {
    right = median(jr);
    jambs++;
  }
  // The head spans exactly the opening; an open door swung back against a jamb (its
  // slab facing along the wall too) can pass for a jamb further out.
  const hs = head.filter((p) => p.t > left - 6 && p.t < right + 6 && p.z > zc).map((p) => p.t).sort((x, y) => x - y);
  if (hs.length >= 15) {
    const h0 = hs[Math.floor(hs.length * 0.03)];
    const h1 = hs[Math.floor(hs.length * 0.97)];
    // The head's mesh rounds off ~1" short of each end: only a jamb well past it is wrong.
    if (left < h0 - 3) left = h0 - 1;
    if (right > h1 + 3) right = h1 + 1;
  }
  const width = right - left;
  if (width < MIN_W || width > MAX_W) return null;
  const inside = (t: number) => t > left + 1.5 && t < right - 1.5;

  // Top: the head's underside, else the lowest wall face above where you point.
  let top = 0;
  let headSeen = false;
  const hz = head.filter((p) => inside(p.t) && p.z > zc).map((p) => p.z);
  const above = face.filter((p) => inside(p.t) && p.z > zc).map((p) => p.z);
  if (hz.length >= 6) {
    top = Math.min(...hz.filter((z) => z <= median(hz) + 1));
    top = median(hz.filter((z) => z < top + 2));
    headSeen = true;
  } else if (above.length >= 6) {
    const s = [...above].sort((x, y) => x - y);
    top = s[Math.floor(s.length * 0.05)];
    headSeen = true;
  }
  // Bottom: wall standing below the opening across most of it makes it a window.
  const below = face.filter((p) => inside(p.t) && p.z > LOW && p.z < zc).map((p) => p.z);
  let sill = 0;
  const st = sillTop.filter((p) => inside(p.t) && p.z < zc).map((p) => p.z);
  if (st.length >= 6 && below.length >= 12) sill = median(st);
  else if (below.length >= 12) {
    const s = [...below].sort((x, y) => x - y);
    const up = s[Math.floor(s.length * 0.95)];
    const span = new Set(face.filter((p) => inside(p.t) && p.z > LOW && p.z < up).map((p) => Math.floor(p.t / 3)));
    if (up > 18 && span.size >= ((right - left - 3) / 3) * 0.6) sill = up;
  }
  const type = sill > 6 ? 'window' : 'door';
  if (!headSeen) top = type === 'door' ? Math.min(80, w.height - 2) : sill + 36;
  const height = Math.max(12, Math.min(w.height, top) - sill);
  return {
    offset: (left + right) / 2,
    width: Math.round(width * 4) / 4,
    height: Math.round(height * 4) / 4,
    sill: Math.round(sill * 4) / 4,
    type,
    jambs,
    headSeen,
  };
}
