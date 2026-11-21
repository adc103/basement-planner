import {
  InputComponent,
  Quaternion,
  Raycaster,
  Vector3,
  XRAnchor,
  XRPlane,
  type Entity,
  type Object3D,
  type World,
} from '@iwsdk/core';
import { IDENTITY, type PlanTransform } from '../core/alignment.js';
import { replaceExistingWalls } from '../core/ops.js';
import { loadSavedPlan, savePlan } from '../core/persistence.js';
import type { Plan } from '../core/plan.js';
import { wallsFromScan, type ScanPlane } from '../core/roomScan.js';
import { defaultSnapOptions, primaryAxis, type SnapOptions } from '../core/snapping.js';
import { PlanStore } from '../core/store.js';
import { formatLength, INCH_M } from '../core/units.js';
import type { Vec2 } from '../core/geom2d.js';
import { HandAim, type Side } from './input.js';
import { Keypad } from './keypad.js';
import { TextLabel } from './labels.js';
import { WristMenu } from './menu.js';
import { ButtonPanel } from './panel.js';
import { localToPlan, PlanView } from './planView.js';
import { Preview } from './preview.js';
import { AlignTool } from './tools/alignTool.js';
import { DeleteTool } from './tools/deleteTool.js';
import { OpeningTool } from './tools/openingTool.js';
import type { AimHit, Tool, ToolContext } from './tools/tool.js';
import { WallTool } from './tools/wallTool.js';

const TRANSFORM_KEY = 'basement-planner:transform:v1';
const IWSDK_ANCHOR_KEY = 'iwsdk_scene_anchor_uuid';

interface SavedTransform extends PlanTransform {
  floorY: number;
  anchorUuid: string | null;
}

type ToolName = 'walls' | 'doors' | 'delete' | 'align';

export interface AppStatus {
  walls: number;
  existing: number;
  openings: number;
  linearFeet: number;
  restored: boolean;
  savedAt: string | null;
}

/**
 * The planner: owns the plan store, the 3D view, the tools and the in-headset UI.
 * Driven once per frame by PlannerSystem.
 */
export class PlannerApp {
  readonly store: PlanStore;
  readonly view = new PlanView();
  readonly preview = new Preview();
  private planEntity!: Entity;
  private hands: Record<Side, HandAim> = { left: new HandAim('left'), right: new HandAim('right') };
  private activeSide: Side = 'right';
  private tools!: Record<ToolName, Tool>;
  private toolName: ToolName = 'walls';
  private wallTool!: WallTool;
  private menuPanel!: ButtonPanel;
  private keypad!: Keypad;
  private menu!: WristMenu;
  private toastLabel = new TextLabel('', { height: 0.045, bg: 'rgba(15,20,30,0.92)' });
  private toastUntil = 0;
  private time = 0;
  private snapEnabled = true;
  private preset: { type: 'door' | 'opening'; width: number; height: number } = { type: 'door', width: 32, height: 80 };
  private transform: SavedTransform;
  private axisAngle = 0;
  private raycaster = new Raycaster();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedAt: string | null = null;
  private restored: boolean;
  private needsAlignWarned = false;
  private heightRepeatAt = 0;
  private listeners = new Set<() => void>();
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private tmpQ = new Quaternion();

  constructor(private world: World) {
    const { plan, restored } = loadSavedPlan();
    this.restored = restored;
    this.store = new PlanStore(plan);
    this.transform = this.loadTransform();
    this.store.subscribe((p, reason) => this.onPlanChanged(p, reason));
  }

  init(): void {
    const world = this.world;
    this.view.root.add(this.preview.root);
    this.planEntity = world.createTransformEntity(this.view.root, { parent: world.sceneEntity, persistent: true });
    // Keep the plan attached to IWSDK's persistent scene anchor, so it stays put in the
    // room across sessions when the headset can restore the anchor.
    this.planEntity.addComponent(XRAnchor);

    const ctx: ToolContext = {
      store: this.store,
      view: this.view,
      preview: this.preview,
      toast: (m, s) => this.toast(m, s),
      snapOptions: (aim, from) => this.snapOptions(aim, from),
      openKeypad: (title, initial, onOk) => this.openKeypad(title, initial, onOk),
      openingPreset: () => this.preset,
      refreshUi: () => this.refreshUi(),
    };
    this.wallTool = new WallTool(ctx);
    this.tools = {
      walls: this.wallTool,
      doors: new OpeningTool(ctx),
      delete: new DeleteTool(ctx),
      align: new AlignTool(ctx, {
        getTransform: () => this.transform,
        setTransform: (t) => this.setTransform(t),
      }),
    };

    this.buildMenu();
    this.keypad = new Keypad(world);
    this.menu = new WristMenu(world, [this.menuPanel]);
    world.scene.add(this.toastLabel.sprite);
    this.toastLabel.sprite.visible = false;

    this.onPlanChanged(this.store.plan, 'load');
    this.applyTransform();
  }

  // ---------------------------------------------------------------- UI ----

  private buildMenu(): void {
    const tool = (name: ToolName, label: string) => ({
      id: `tool-${name}`,
      label,
      onClick: () => this.setTool(name),
      active: () => this.toolName === name,
    });
    const preset = (type: 'door' | 'opening', width: number, label: string) => ({
      id: `preset-${type}-${width}`,
      label,
      onClick: () => {
        this.preset = { type, width, height: 80 };
        this.setTool('doors');
      },
      active: () => this.toolName === 'doors' && this.preset.type === type && this.preset.width === width,
    });
    this.menuPanel = new ButtonPanel(this.world, {
      title: 'Basement Planner',
      columns: 4,
      columnWidth: 0.062,
      buttonHeight: 0.032,
      rows: [
        [tool('walls', 'Walls'), tool('doors', 'Doors'), tool('delete', 'Delete'), tool('align', 'Align')],
        [
          { id: 'undo', label: 'Undo', onClick: () => this.undo(), enabled: () => this.store.canUndo || this.wallTool.drawing },
          { id: 'redo', label: 'Redo', onClick: () => this.store.redo(), enabled: () => this.store.canRedo },
          { id: 'finish', label: 'Finish', onClick: () => this.wallTool.endChain(), enabled: () => this.wallTool.drawing },
          { id: 'snap', label: () => (this.snapEnabled ? 'Snap: on' : 'Snap: off'), onClick: () => this.toggleSnap(), active: () => this.snapEnabled },
        ],
        [
          { id: 'len', label: 'Length...', onClick: () => this.wallTool.typeLength(), enabled: () => !!this.wallTool.lastWall() },
          { id: 'height', label: () => `H ${formatLength(this.store.plan.settings.wallHeight)}`, onClick: () => this.wallTool.typeHeight() },
          {
            id: 'mode',
            label: () => (this.view.mode === 'ghost' ? 'View: ghost' : 'View: solid'),
            onClick: () => this.view.setMode(this.view.mode === 'ghost' ? 'solid' : 'ghost'),
          },
          {
            id: 'labels',
            label: () => (this.view.showLabels ? 'Labels: on' : 'Labels: off'),
            onClick: () => (this.view.showLabels = !this.view.showLabels),
            active: () => this.view.showLabels,
          },
        ],
        [preset('door', 30, 'Door 30"'), preset('door', 32, 'Door 32"'), preset('door', 36, 'Door 36"'), preset('opening', 36, 'Open 36"')],
        [
          { id: 'custom', label: 'Width...', onClick: () => this.customWidth() },
          { id: 'scan', label: 'Import scan', onClick: () => this.importScan() },
          { id: 'refreset', label: 'Reset refs', onClick: () => this.resetReference(), enabled: () => !!this.store.plan.reference },
          { id: 'pin', label: () => (this.menu?.pinned ? 'Unpin' : 'Pin menu'), onClick: () => this.menu.togglePin(), active: () => !!this.menu?.pinned },
        ],
        [{ id: 'exit', label: 'Exit AR (saves)', span: 4, tone: 'danger', onClick: () => this.world.exitXR() }],
      ],
    });
    this.menuPanel.setVisible(false);
  }

  private refreshUi(): void {
    this.menuPanel?.refresh();
    for (const l of this.listeners) l();
  }

  private setTool(name: ToolName): void {
    if (name === this.toolName) {
      this.tools[name].activate();
      this.refreshUi();
      return;
    }
    this.tools[this.toolName].deactivate();
    this.toolName = name;
    this.tools[name].activate();
    this.preview.clear();
    this.refreshUi();
  }

  private toggleSnap(): void {
    this.snapEnabled = !this.snapEnabled;
    this.toast(this.snapEnabled ? 'Snapping on' : 'Snapping off');
  }

  private customWidth(): void {
    this.openKeypad('Opening width', this.preset.width, (w) => {
      if (w < 12 || w > 120) {
        this.toast('Width should be between 1 and 10 ft');
        return;
      }
      this.preset = { ...this.preset, width: w };
      this.setTool('doors');
    });
  }

  private openKeypad(title: string, initial: number | null, onOk: (inches: number) => void): void {
    this.keypad.show(title, initial, onOk);
    // Float the keypad in front of the user, at chest height.
    const cam = this.world.camera;
    const head = cam.getWorldPosition(this.tmpV);
    const fwd = this.tmpV2.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(this.tmpQ));
    fwd.y = 0;
    fwd.normalize();
    const pos = head.clone().addScaledVector(fwd, 0.45);
    pos.y -= 0.25;
    const root = this.keypad.panel.root;
    root.position.copy(pos);
    root.rotation.set(-0.5, Math.atan2(-fwd.x, -fwd.z), 0, 'YXZ');
  }

  toast(msg: string, seconds = 3): void {
    this.toastLabel.setText(msg);
    this.toastLabel.sprite.visible = true;
    this.toastUntil = this.time + seconds;
  }

  private undo(): void {
    if (this.tools[this.toolName].undo?.()) return;
    const label = this.store.undo();
    this.toast(label ? `Undid: ${label}` : 'Nothing to undo');
  }

  private resetReference(): void {
    this.store.edit('Reset reference corners', (d) => {
      d.reference = null;
    });
    this.setTool('align');
    this.toast('Click two real floor corners to set new references');
  }

  // ------------------------------------------------------- plan + frame ----

  private onPlanChanged(plan: Plan, _reason: string): void {
    this.view.rebuild(plan);
    this.axisAngle = primaryAxis(plan);
    this.scheduleSave();
    this.refreshUi();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (savePlan(this.store.plan)) this.savedAt = new Date().toLocaleTimeString();
    this.refreshUi();
  }

  private loadTransform(): SavedTransform {
    try {
      const raw = localStorage.getItem(TRANSFORM_KEY);
      if (raw) {
        const t = JSON.parse(raw) as SavedTransform;
        if ([t.theta, t.tx, t.tz, t.floorY].every(Number.isFinite)) return t;
      }
    } catch {
      /* ignore */
    }
    return { ...IDENTITY, floorY: 0, anchorUuid: null };
  }

  private storeTransform(): void {
    try {
      localStorage.setItem(TRANSFORM_KEY, JSON.stringify(this.transform));
    } catch {
      /* ignore */
    }
  }

  private currentAnchorUuid(): string | null {
    try {
      return localStorage.getItem(IWSDK_ANCHOR_KEY);
    } catch {
      return null;
    }
  }

  private setTransform(t: PlanTransform): void {
    this.transform = { ...this.transform, ...t, anchorUuid: this.currentAnchorUuid() };
    this.applyTransform();
    this.storeTransform();
  }

  private applyTransform(): void {
    const r = this.view.root;
    r.position.set(this.transform.tx, this.transform.floorY, this.transform.tz);
    r.rotation.set(0, -this.transform.theta, 0);
  }

  // ----------------------------------------------------------- per frame ----

  update(delta: number, time: number): void {
    this.time = time;
    const world = this.world;
    const inXR = !!world.session;

    // The anchor system may re-parent the plan root; keep our transform as its local pose.
    this.applyTransform();
    this.checkAnchor();

    if (inXR) {
      this.hands.left.update(world, time);
      this.hands.right.update(world, time);
      this.handleButtons(time);
      this.menu.update();
      this.menuPanel.setTitle(this.statusTitle());
      this.handleTool();
    }

    this.view.updateLabels(world.camera);
    this.updateToast();
    void delta;
  }

  private statusTitle(): string {
    const t = this.tools[this.toolName];
    return this.keypad.open ? 'Enter a value on the keypad' : t.hint();
  }

  private checkAnchor(): void {
    if (!this.world.session || this.needsAlignWarned) return;
    const uuid = this.currentAnchorUuid();
    if (!uuid) return;
    if (!this.transform.anchorUuid) {
      // First anchor seen for this plan: adopt it.
      this.transform.anchorUuid = uuid;
      this.storeTransform();
    } else if (this.transform.anchorUuid !== uuid && this.store.plan.walls.length) {
      this.needsAlignWarned = true;
      this.toast(
        this.store.plan.reference
          ? 'Room anchor changed. Use Align and click Ref 1 then Ref 2.'
          : 'Room anchor changed. Plan may be offset: set reference corners with Align.',
        7,
      );
      this.transform.anchorUuid = uuid;
      this.storeTransform();
    }
  }

  private handleButtons(time: number): void {
    const R = this.hands.right;
    const L = this.hands.left;
    const w = this.world;
    if (R.buttonDown(InputComponent.B_Button, w) || L.buttonDown(InputComponent.Y_Button, w)) this.undo();
    if (R.buttonDown(InputComponent.A_Button, w)) this.wallTool.endChain();
    if (L.buttonDown(InputComponent.X_Button, w)) this.menu.hiddenByUser = !this.menu.hiddenByUser;
    // Right thumbstick up/down: wall height in 1" steps.
    const y = R.isHand ? 0 : R.thumbY(w);
    if (Math.abs(y) > 0.6 && time >= this.heightRepeatAt) {
      const h = Math.max(24, this.store.plan.settings.wallHeight + (y < 0 ? 1 : -1));
      this.wallTool.applyHeight(h);
      this.heightRepeatAt = time + 0.12;
    }
  }

  private uiObjects(): Object3D[] {
    const out: Object3D[] = [];
    if (this.menuPanel.visible) out.push(this.menuPanel.backing);
    if (this.keypad.open) out.push(this.keypad.panel.backing);
    return out;
  }

  private rayHitsUI(h: HandAim): boolean {
    const objs = this.uiObjects();
    if (!objs.length) return false;
    this.raycaster.set(h.origin, h.dir);
    this.raycaster.far = 5;
    return this.raycaster.intersectObjects(objs, false).length > 0;
  }

  private handleTool(): void {
    const tool = this.tools[this.toolName];
    // A modal keypad blocks drawing.
    const modal = this.keypad.open;

    for (const side of ['left', 'right'] as Side[]) {
      const h = this.hands[side];
      if (!h.tracked) continue;
      if (h.selectStarted) {
        h.pressOnUI = this.rayHitsUI(h) || modal;
        if (!h.pressOnUI) this.activeSide = side;
      }
    }
    let active = this.hands[this.activeSide];
    if (!active.tracked) {
      const other = this.hands[this.activeSide === 'left' ? 'right' : 'left'];
      if (other.tracked) {
        this.activeSide = other.side;
        active = other;
      }
    }

    const aimingUI = modal || this.rayHitsUI(active);
    const aim = active.tracked && !aimingUI && !active.pressOnUI ? this.computeAim(active) : null;
    tool.hover(aim);

    for (const side of ['left', 'right'] as Side[]) {
      const h = this.hands[side];
      if (!h.selectEnded) continue;
      if (!h.pressOnUI && side === this.activeSide && !modal) {
        const a = this.computeAim(h);
        tool.commit(a);
      }
      h.finishPress();
    }
  }

  private computeAim(h: HandAim): AimHit {
    const root = this.view.root;
    root.updateWorldMatrix(true, false);
    // Ray into plan-root local space.
    const o = root.worldToLocal(this.tmpV.copy(h.aimOrigin));
    root.getWorldQuaternion(this.tmpQ).invert();
    const d = this.tmpV2.copy(h.aimDir).applyQuaternion(this.tmpQ);
    let floor: Vec2 | null = null;
    let floorDistM = 0;
    if (d.y < -0.02) {
      const t = -o.y / d.y;
      if (t > 0 && t < 20) {
        floor = { x: (o.x + d.x * t) / INCH_M, y: (o.z + d.z * t) / INCH_M };
        floorDistM = t;
      }
    }
    // Walls hit in world space.
    let wall: AimHit['wall'] = null;
    this.raycaster.set(h.aimOrigin, h.aimDir);
    this.raycaster.far = 20;
    const hit = this.raycaster.intersectObjects(this.view.wallMeshes, false)[0];
    if (hit) {
      const lp = root.worldToLocal(hit.point.clone());
      wall = { wallId: hit.object.userData.wallId as string, point: localToPlan(lp), distM: hit.distance };
    }
    const eyeW = this.world.camera.getWorldPosition(new Vector3());
    const eye = localToPlan(root.worldToLocal(eyeW));
    return { floor, floorDistM, wall, fine: h.phase === 'fine', pressing: h.phase !== 'idle', eye };
  }

  private snapOptions(aim: AimHit, from?: Vec2): SnapOptions {
    const st = this.store.plan.settings;
    // ~1.5 degrees of arc at the aim distance, clamped to 1-6 inches.
    const tolIn = Math.min(6, Math.max(1, (Math.tan((1.5 * Math.PI) / 180) * aim.floorDistM) / INCH_M));
    return {
      ...defaultSnapOptions,
      tolerance: aim.fine ? 0.75 : tolIn,
      grid: aim.fine ? 0.25 : 1,
      from,
      axisAngle: this.axisAngle,
      drawThickness: st.wallThickness,
      foundationGap: st.framing.foundationGap,
      disabled: !this.snapEnabled,
    };
  }

  private updateToast(): void {
    const s = this.toastLabel.sprite;
    if (!s.visible) return;
    if (this.time > this.toastUntil) {
      s.visible = false;
      return;
    }
    const cam = this.world.camera;
    const p = cam.getWorldPosition(this.tmpV);
    const fwd = this.tmpV2.set(0, -0.35, -1).applyQuaternion(cam.getWorldQuaternion(this.tmpQ)).normalize();
    s.position.copy(p).addScaledVector(fwd, 0.9);
  }

  // ------------------------------------------------------------- scan ----

  private importScan(): void {
    const planes: ScanPlane[] = [];
    for (const e of this.planeEntities()) {
      const raw = e.getValue(XRPlane, '_plane') as unknown as { semanticLabel?: string; polygon?: DOMPointReadOnly[] };
      const obj = e.object3D;
      if (!raw || !obj) continue;
      obj.updateWorldMatrix(true, false);
      const points = (raw.polygon ?? []).map((p) => obj.localToWorld(new Vector3(p.x, p.y, p.z)));
      planes.push({ label: raw.semanticLabel ?? '', points });
    }
    if (!planes.length) {
      this.toast('No room scan found. Run Space Setup in Quest settings, then try again.', 6);
      return;
    }
    const root = this.view.root;
    root.updateWorldMatrix(true, false);
    const st = this.store.plan.settings;
    const res = wallsFromScan(
      planes,
      (w) => {
        const l = root.worldToLocal(new Vector3(w.x, w.y, w.z));
        return { p: { x: l.x / INCH_M, y: l.z / INCH_M }, y: l.y };
      },
      st.foundationThickness,
    );
    if (res.floorY !== null && Math.abs(res.floorY) < 0.3) {
      this.transform.floorY += res.floorY;
      this.applyTransform();
      this.storeTransform();
    }
    const ceilingIn = res.ceilingY !== null && res.floorY !== null ? (res.ceilingY - res.floorY) / INCH_M : null;
    this.store.edit('Import room scan', (d) => {
      replaceExistingWalls(d, res.walls, ceilingIn && ceilingIn > 60 ? Math.round(ceilingIn * 4) / 4 : d.settings.wallHeight);
      if (ceilingIn && ceilingIn > 60 && ceilingIn < 180) d.settings.wallHeight = Math.round(ceilingIn * 4) / 4;
    });
    this.toast(
      `Imported ${res.walls.length} walls${ceilingIn ? `, ceiling ${formatLength(Math.round(ceilingIn * 4) / 4)}` : ''}`,
      5,
    );
  }

  /** Detected planes, read through a tiny query-less scan of the ECS. */
  private planeEntities(): Entity[] {
    return [...(this.planeQuery?.() ?? [])];
  }

  planeQuery: (() => Iterable<Entity>) | null = null;

  // ------------------------------------------------------------ DOM api ----

  onSession(fn: (active: boolean) => void): () => void {
    const xr = this.world.renderer.xr;
    const on = () => fn(true);
    const off = () => fn(false);
    xr.addEventListener('sessionstart', on);
    xr.addEventListener('sessionend', off);
    return () => {
      xr.removeEventListener('sessionstart', on);
      xr.removeEventListener('sessionend', off);
    };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status(): AppStatus {
    const p = this.store.plan;
    let lin = 0;
    for (const w of p.walls) {
      if (w.kind !== 'new') continue;
      const a = p.nodes.find((n) => n.id === w.a)!;
      const b = p.nodes.find((n) => n.id === w.b)!;
      lin += Math.hypot(a.x - b.x, a.y - b.y);
    }
    return {
      walls: p.walls.filter((w) => w.kind === 'new').length,
      existing: p.walls.filter((w) => w.kind === 'existing').length,
      openings: p.openings.length,
      linearFeet: lin / 12,
      restored: this.restored,
      savedAt: this.savedAt,
    };
  }

  enterAR(): void {
    this.world.launchXR();
  }

  loadPlan(plan: Plan): void {
    this.wallTool.endChain();
    this.store.load(plan);
  }
}
