import { captureWall } from '../../core/capture.js';
import type { WallFit } from '../../core/fit.js';
import { dist, type Vec2 } from '../../core/geom2d.js';
import { joinEnds } from '../../core/joinWall.js';
import { pickSetupWall, type PickedWall, type Ray3, type SetupPlane } from '../../core/pickWall.js';
import { formatLength } from '../../core/units.js';
import type { WallPick } from '../roomMesh.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/** Where Real wall gets its walls from. */
export interface TraceSources {
  /** The wall under a ray on the room mesh (null: no mesh or no worker). */
  pick(ray: Ray3, thickness: number, height: number): Promise<WallPick | null>;
  hasMesh(): boolean;
  /** Space Setup planes seen this session (plan inches). */
  setupPlanes(): SetupPlane[];
}

/** A wall found under the ray, ready to add. */
interface Proposal {
  from: 'mesh' | 'setup';
  face: PickedWall;
  /** Centerline and thickness to add. */
  a: Vec2;
  b: Vec2;
  thickness: number;
  fit: WallFit | null;
}

type Found = ({ proposal: Proposal } | { miss: string }) & { ray: Ray3; at: number };

/** Last wall added: a tap on the same face moves its nearer end there. */
interface Last {
  id: string;
  face: { a: Vec2; n: Vec2; u: Vec2 };
}

const MISS_TEXT: Record<string, string> = {
  nothing: 'No scanned surface there: scan this wall, or tap two points on it',
  'not-a-wall': 'That is floor or ceiling: aim at the wall itself',
  'too-little': 'Too little scan there: aim at a clearer part of the wall',
  unclear: "Can't tell this wall's line here: aim at a clearer, flatter part",
};

/**
 * Real wall: point at a wall and tap. The wall is found on the room mesh (fitted to
 * the whole patch around where you point, then followed to its corners), or taken
 * from Space Setup where the mesh hasn't covered it. Tap the same wall again to end
 * it at that spot. With neither, tap two points on the wall.
 */
export class TraceTool implements Tool {
  readonly name = 'Real wall';
  private found: Found | null = null;
  private lastAsk = 0;
  private inFlight = false;
  private busy = false;
  private last: Last | null = null;
  /** Two-tap fallback (no mesh, no Space Setup there): the first point. */
  private first: { p: Vec2; z: number; n: Vec2 } | null = null;

  constructor(
    private ctx: ToolContext,
    private src: TraceSources,
  ) {}

  activate(): void {
    this.first = null;
    this.last = null;
    this.found = null;
  }

  deactivate(): void {
    this.first = null;
    this.last = null;
    this.ctx.preview.clear();
  }

  hint(): string {
    if (this.first) return 'First end set. Tap the same wall near its other end (B to cancel)';
    if (this.last) return 'Tap this wall again to end it there, or point at the next wall';
    return 'Point at a real wall and tap';
  }

  undo(): boolean {
    if (!this.first) return false;
    this.first = null;
    this.ctx.preview.clear();
    this.ctx.refreshUi();
    return true;
  }

  private settings() {
    return this.ctx.store.plan.settings;
  }

  /** Find the wall under a ray: room mesh first, then Space Setup. */
  private async find(ray: Ray3): Promise<Found> {
    const st = this.settings();
    const at = performance.now();
    const r = this.src.hasMesh() ? await this.src.pick(ray, st.captureThickness, st.wallHeight) : null;
    if (r && 'wall' in r.result) return { proposal: this.proposal('mesh', r.result.wall, r.fit), ray, at };
    const ss = pickSetupWall(this.src.setupPlanes(), ray);
    if (ss) return { proposal: this.proposal('setup', ss, null), ray, at };
    return { miss: r && 'miss' in r.result ? r.result.miss : 'nothing', ray, at };
  }

  /**
   * The last answer, if it was for about the ray you're aiming now: a wall you've aimed
   * well away from isn't shown, yet small hand motion between answers doesn't blink it.
   */
  private current(ray: Ray3): Found | null {
    const f = this.found;
    if (!f) return null;
    const a = f.ray;
    const cos = a.d.x * ray.d.x + a.d.y * ray.d.y + a.d.z * ray.d.z;
    return cos > Math.cos((6 * Math.PI) / 180) && Math.hypot(a.o.x - ray.o.x, a.o.y - ray.o.y, a.o.z - ray.o.z) < 8 ? f : null;
  }

  private proposal(from: Proposal['from'], face: PickedWall, fit: WallFit | null): Proposal {
    const st = this.settings();
    if (fit && fit.evidence !== 'inferred') return { from, face, a: fit.a, b: fit.b, thickness: Math.round(fit.thickness * 4) / 4, fit };
    const h = st.captureThickness / 2;
    const back = (p: Vec2) => ({ x: p.x - face.n.x * h, y: p.y - face.n.y * h });
    return { from, face, a: back(face.a), b: back(face.b), thickness: st.captureThickness, fit: null };
  }

  /** One pick in flight at a time, at most ~12 a second, and only when the aim moved. */
  private request(ray: Ray3): void {
    if (this.inFlight) return;
    const now = performance.now();
    if (now - this.lastAsk < 80) return;
    const f = this.found;
    if (f && f.ray.d.x * ray.d.x + f.ray.d.y * ray.d.y + f.ray.d.z * ray.d.z > Math.cos((0.3 * Math.PI) / 180) && Math.hypot(f.ray.o.x - ray.o.x, f.ray.o.y - ray.o.y, f.ray.o.z - ray.o.z) < 0.5) return;
    this.lastAsk = now;
    this.inFlight = true;
    void this.find({ o: { ...ray.o }, d: { ...ray.d } }).then((r) => {
      this.found = r;
      this.inFlight = false;
    });
  }

  /** The last wall's new ends if this face point is on its face; null otherwise. */
  private trim(face: PickedWall | null, aim: AimHit): { a: Vec2; b: Vec2 } | null {
    const L = this.last;
    if (!L) return null;
    const w = this.ctx.store.plan.walls.find((x) => x.id === L.id);
    if (!w) return null;
    let p: Vec2 | null = null;
    if (face) {
      const par = Math.abs(face.n.x * L.face.n.x + face.n.y * L.face.n.y);
      const off = Math.abs((face.hit.x - L.face.a.x) * L.face.n.x + (face.hit.y - L.face.a.y) * L.face.n.y);
      if (par > 0.999 && off < 2) p = face.hit;
    } else if (aim.surface) {
      const off = Math.abs((aim.surface.p.x - L.face.a.x) * L.face.n.x + (aim.surface.p.y - L.face.a.y) * L.face.n.y);
      if (off < 4) p = aim.surface.p;
    }
    if (!p) return null;
    const nodes = this.ctx.store.plan.nodes;
    const na = nodes.find((n) => n.id === w.a);
    const nb = nodes.find((n) => n.id === w.b);
    if (!na || !nb) return null;
    const a = { x: na.x, y: na.y };
    const b = { x: nb.x, y: nb.y };
    const len = dist(a, b);
    if (len < 1) return null;
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const s = (p.x - a.x) * u.x + (p.y - a.y) * u.y;
    const at = { x: a.x + u.x * s, y: a.y + u.y * s };
    // Move the end nearer the tap (past an end: extend it).
    const toA = Math.abs(s);
    const toB = Math.abs(len - s);
    const r = toA < toB ? { a: at, b } : { a, b: at };
    return dist(r.a, r.b) >= 6 ? r : null;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    if (!aim) return;
    if (this.first) {
      this.hoverTwoTap(aim);
      return;
    }
    this.request(aim.ray);
    const f = this.current(aim.ray);
    const face = f && 'proposal' in f ? f.proposal.face : null;
    const t = this.trim(face, aim);
    if (t && face) {
      // The wall's new extent, as a line along the wall where you're pointing.
      pv.showSurfaceCursor(face.hit, face.n);
      this.faceLine(t.a, t.b, face, `${formatLength(Math.round(dist(t.a, t.b)))}: tap to end it here`);
      return;
    }
    if (f && 'proposal' in f) {
      const p = f.proposal;
      pv.showSurfaceCursor(p.face.hit, p.face.n);
      const j = joinEnds(this.ctx.store.plan, p.a, p.b, p.thickness);
      const unseen = p.face.ends.includes('unseen');
      const note = p.from === 'setup' ? ' (Space Setup)' : unseen ? ' (scan ends: tap again to set the end)' : '';
      this.faceLine(j.a, j.b, p.face, `${formatLength(Math.round(dist(p.face.a, p.face.b)))}${note}`);
    } else if (f && 'miss' in f && aim.floor) {
      pv.showHint(MISS_TEXT[f.miss] ?? MISS_TEXT.nothing, aim.floor, 20);
    }
  }

  /**
   * Show a wall to be added as a line across its face at the height you're pointing
   * (centerline ends a, b brought forward to the face): light enough to see the real
   * wall through, unlike a full-height slab.
   */
  private faceLine(a: Vec2, b: Vec2, face: PickedWall, label: string): void {
    const off = (a.x - face.a.x) * face.n.x + (a.y - face.a.y) * face.n.y;
    const f = (p: Vec2) => ({ x: p.x - face.n.x * off, y: p.y - face.n.y * off, z: face.hit.z });
    this.ctx.preview.showMeasureLine(f(a), f(b), label);
  }

  commit(aim: AimHit): void {
    if (this.busy) return;
    if (this.first) {
      this.commitTwoTap(aim);
      return;
    }
    // Always decide on a fresh pick at the tap, not the preview's last answer.
    this.busy = true;
    const ray: Ray3 = { o: { ...aim.ray.o }, d: { ...aim.ray.d } };
    const surface = aim.surface ? { ...aim.surface } : null;
    void this.find(ray).then((f) => {
      this.busy = false;
      this.found = f;
      this.apply(f, { ...aim, surface });
    });
  }

  private apply(f: Found, aim: AimHit): void {
    const face = 'proposal' in f ? f.proposal.face : null;
    const t = this.trim(face, aim);
    if (t && this.last) {
      const id = this.last.id;
      this.ctx.cmd.group('End real wall', () => this.ctx.act('wall.place', { id, a: t.a, b: t.b }));
      this.ctx.toast(`Wall is now ${formatLength(Math.round(dist(t.a, t.b)))}`, 3);
      this.ctx.refreshUi();
      return;
    }
    if ('proposal' in f) {
      this.add(f.proposal);
      return;
    }
    // Nothing known there: fall back to two taps on the headset's hit test.
    const s = aim.surface;
    if (s && Math.hypot(s.n.x, s.n.y) > 0.5) {
      this.first = { p: { ...s.p }, z: s.z, n: { ...s.n } };
      this.ctx.toast(`${MISS_TEXT[f.miss] ?? MISS_TEXT.nothing}. First end set: tap near the other end`, 4);
      this.ctx.refreshUi();
      return;
    }
    this.ctx.toast(MISS_TEXT[f.miss] ?? MISS_TEXT.nothing, 3);
  }

  /** A wall already in the plan along the same line as the proposal (overlapping half or more). */
  private sameWall(p: Proposal): { id: string; a: Vec2; b: Vec2 } | null {
    const plan = this.ctx.store.plan;
    const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
    const L = dist(p.a, p.b);
    if (L < 1) return null;
    const u = { x: (p.b.x - p.a.x) / L, y: (p.b.y - p.a.y) / L };
    for (const w of plan.walls) {
      const na = nodes.get(w.a);
      const nb = nodes.get(w.b);
      if (!na || !nb) continue;
      const LW = Math.hypot(nb.x - na.x, nb.y - na.y);
      if (LW < 1) continue;
      const v = { x: (nb.x - na.x) / LW, y: (nb.y - na.y) / LW };
      if (Math.abs(u.x * v.x + u.y * v.y) < Math.cos((5 * Math.PI) / 180)) continue;
      const mid = { x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 };
      const off = Math.abs((mid.x - p.a.x) * -u.y + (mid.y - p.a.y) * u.x);
      if (off > Math.max(6, (w.thickness + p.thickness) / 2 + 2)) continue;
      const s0 = (na.x - p.a.x) * u.x + (na.y - p.a.y) * u.y;
      const s1 = (nb.x - p.a.x) * u.x + (nb.y - p.a.y) * u.y;
      const overlap = Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
      if (overlap >= 0.5 * Math.min(L, LW)) return { id: w.id, a: { x: na.x, y: na.y }, b: { x: nb.x, y: nb.y } };
    }
    return null;
  }

  private add(p: Proposal): void {
    let id: string | null = null;
    // Meet the walls already there: a T, or one shared corner.
    const j = joinEnds(this.ctx.store.plan, p.a, p.b, p.thickness);
    const same = this.sameWall(p);
    if (same) {
      // Already in the plan (Space Setup, drawn, or traced before): fit that wall to the
      // measurement instead of adding a second one on top of it.
      const w = this.ctx.store.plan.walls.find((x) => x.id === same.id)!;
      const flip = (same.b.x - same.a.x) * (j.b.x - j.a.x) + (same.b.y - same.a.y) * (j.b.y - j.a.y) < 0;
      const a = flip ? j.b : j.a;
      const b = flip ? j.a : j.b;
      const L = dist(a, b) || 1;
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      // Openings keep their real place: offsets are measured from the wall's a end.
      const shift = (same.a.x - a.x) * u.x + (same.a.y - a.y) * u.y;
      const ops = this.ctx.store.plan.openings.filter((o) => o.wallId === w.id);
      const ok = this.ctx.cmd.group('Fit real wall', () => {
        if (w.kind !== 'existing') this.ctx.act('wall.setKind', { id: w.id, kind: 'existing' });
        if (this.ctx.act('wall.place', { id: w.id, a, b }) === null) return false;
        this.ctx.act('wall.setThickness', { id: w.id, thickness: p.thickness });
        for (const o of ops) this.ctx.cmd.run('opening.update', { id: o.id, offset: o.offset + shift });
        if (p.fit) this.ctx.cmd.run('scan.setEvidence', { items: [{ id: w.id, evidence: p.fit.evidence, confidence: p.fit.confidence }] }, 'scan');
        return true;
      });
      if (!ok) return;
      id = w.id;
      const fu = { x: p.face.b.x - p.face.a.x, y: p.face.b.y - p.face.a.y };
      const fl = Math.hypot(fu.x, fu.y) || 1;
      this.last = { id, face: { a: p.face.a, n: p.face.n, u: { x: fu.x / fl, y: fu.y / fl } } };
      this.ctx.toast(`That wall was already in your plan: fitted it to the scan (${formatLength(Math.round(dist(p.face.a, p.face.b)))}, ${p.thickness}" thick)`, 4);
      this.ctx.refreshUi();
      return;
    }
    this.ctx.cmd.group('Trace real wall', () => {
      for (const m of j.moves) this.ctx.act('node.move', { id: m.node, x: m.to.x, y: m.to.y });
      id = this.ctx.act('wall.add', { a: j.a, b: j.b, kind: 'existing', source: 'capture', thickness: p.thickness });
      if (id && p.fit) this.ctx.cmd.run('scan.setEvidence', { items: [{ id, evidence: p.fit.evidence, confidence: p.fit.confidence }] }, 'scan');
    });
    // All or nothing: if the wall couldn't be added, take back the corners moved for it.
    if (!id && j.moves.length && this.ctx.store.undoLabel === 'Trace real wall') this.ctx.store.undo();
    if (!id) return;
    const u = { x: p.face.b.x - p.face.a.x, y: p.face.b.y - p.face.a.y };
    const ul = Math.hypot(u.x, u.y) || 1;
    this.last = { id, face: { a: p.face.a, n: p.face.n, u: { x: u.x / ul, y: u.y / ul } } };
    const len = formatLength(Math.round(dist(p.face.a, p.face.b)));
    const how = p.from === 'setup' ? 'from Space Setup' : p.fit ? `${p.thickness}" thick, measured` : 'one face seen';
    this.ctx.toast(`Real wall added: ${len}, ${how}`, 4);
    this.ctx.refreshUi();
  }

  private hoverTwoTap(aim: AimHit): void {
    const pv = this.ctx.preview;
    const f = this.first!;
    pv.showCursorAt({ x: f.p.x, y: f.p.y, z: f.z }, 'endpoint', false, f.n);
    const q = aim.surface ? aim.surface.p : aim.floor;
    if (!q) return;
    if (aim.surface) pv.showSurfaceCursor({ x: q.x, y: q.y, z: aim.surface.z }, aim.surface.n);
    const label = formatLength(Math.round(dist(f.p, q)));
    pv.showMeasureLine({ x: f.p.x, y: f.p.y, z: f.z }, { x: q.x, y: q.y, z: f.z }, label);
  }

  private commitTwoTap(aim: AimHit): void {
    const q = aim.surface ? aim.surface.p : aim.floor;
    if (!q || !this.first) return;
    const st = this.settings();
    const w = captureWall(this.first.p, q, aim.eye, st.captureThickness);
    if (!w) {
      this.ctx.toast('Tap two spots at least 6" apart along the wall', 3);
      return;
    }
    let id: string | null = null;
    this.ctx.cmd.group('Trace real wall', () => {
      id = this.ctx.act('wall.add', { a: w.a, b: w.b, kind: 'existing', source: 'capture', thickness: st.captureThickness });
    });
    const n0 = this.first.n;
    this.first = null;
    this.ctx.preview.clear();
    if (id) {
      const L = dist(w.faceA, w.faceB) || 1;
      const u = { x: (w.faceB.x - w.faceA.x) / L, y: (w.faceB.y - w.faceA.y) / L };
      let n = { x: -u.y, y: u.x };
      if (n.x * n0.x + n.y * n0.y < 0) n = { x: -n.x, y: -n.y };
      this.last = { id, face: { a: w.faceA, n, u } };
    }
    this.ctx.toast('Real wall added where you tapped (scan it to measure it exactly)', 4);
    this.ctx.refreshUi();
  }
}
