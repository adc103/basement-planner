import { DepthOccludable, OcclusionShadersMode, FollowBehavior, Follower, EnvironmentRaycastTarget, Group, Mesh, PlaneGeometry, InputComponent, Object3D, Quaternion, Raycaster, Vector3, XRAnchor, XRMesh, XRPlane, type Entity, type World } from '@iwsdk/core';
import { IDENTITY, type PlanTransform } from '../core/alignment.js';
import { loadSavedPlan, savePlan } from '../core/persistence.js';
import type { Plan } from '../core/plan.js';
import { obstaclesFromScan, scanSignature, wallsFromScan, type P3, type ScanBox, type ScanPlane } from '../core/roomScan.js';
import { defaultSnapOptions, primaryAxis, type SnapOptions } from '../core/snapping.js';
import { PlanStore } from '../core/store.js';
import { formatLength, INCH_M } from '../core/units.js';
import type { Vec2 } from '../core/geom2d.js';
import { HandAim, type Side } from './input.js';
import { Keypad } from './keypad.js';
import { TextLabel } from './labels.js';
import { WristMenu } from './menu.js';
import { PlanView, type WallViewMode } from './planView.js';
import { Preview } from './preview.js';
import { AlignTool } from './tools/alignTool.js';
import { CaptureTool, type CaptureContext } from './tools/captureTool.js';
import type { PP } from '../core/wallDetect.js';
import { DeleteTool } from './tools/deleteTool.js';
import { EditTool } from './tools/editTool.js';
import { MeasureTool } from './tools/measureTool.js';
import { OpeningTool } from './tools/openingTool.js';
import type { AimHit, Tool } from './tools/tool.js';
import { WallTool } from './tools/wallTool.js';
import { RoomsTool } from './tools/roomsTool.js';
import { PinsTool } from './tools/pinsTool.js';
import { SoffitTool } from './tools/soffitTool.js';
import { RefAnchors } from './refAnchors.js';
import { CameraProbe, PROBE_KEY } from './cameraProbe.js';
import { registerWebMcp } from './webmcp.js';
import { CommandBus, type CommandName, type ParamsOf, type ResultOf } from '../core/commands.js';
import { planToLocal } from './planView.js';
import { solveTwoPoint } from '../core/alignment.js';
import { roomCeiling } from '../core/ops.js';
import { CEILING_NAMES } from '../core/plan2d.js';
import type { CeilingType } from '../core/plan.js';
import { FINISH_NAMES, MARKER_INFO } from '../core/plan2d.js';
import { MARKER_TYPES } from '../core/plan.js';
import { generateFraming, summarizeFraming } from '../core/framing.js';
import type { Finish } from '../core/plan.js';
import { MainMenu, MENU_H, type MenuApi, type ToolName } from './ui/mainMenu.js';
import { Sfx } from './ui/sfx.js';
import { ScanSession } from './scanSession.js';
import { HybridProbe } from './hybridProbe.js';
import type { StructureResult } from '../core/structure.js';
import { ScanReviewTool } from './tools/scanReviewTool.js';
import { findRoomFaces } from '../core/rooms.js';
import { Acquired } from './acquired.js';
import { FloorFinder } from './floorFinder.js';
import { setPokeEnabled } from './ui/poke.js';
import { setSurfaceOcclusion, updateSurfaceOcclusion } from './surfaceOcclusion.js';

const TRANSFORM_KEY = 'basement-planner:transform:v1';
const IWSDK_ANCHOR_KEY = 'iwsdk_scene_anchor_uuid';

interface SavedTransform extends PlanTransform {
  floorY: number;
  anchorUuid: string | null;
}

/** Thumbstick-flick order for controllers. */
const TOOL_CYCLE: ToolName[] = ['walls', 'doors', 'edit', 'measure', 'rooms', 'pins', 'capture', 'delete'];
const TOOL_LABEL: Record<ToolName, string> = {
  walls: 'Walls',
  doors: 'Doors',
  capture: 'Capture wall',
  edit: 'Select',
  delete: 'Delete',
  measure: 'Tape',
  align: 'Align',
  rooms: 'Rooms',
  pins: 'Pins',
  soffit: 'Soffit',
  review: 'Review scan',
};

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
  /** Every change to the plan goes through a command (you, the scanner, an assistant). */
  readonly cmd: CommandBus;
  readonly view = new PlanView();
  readonly preview = new Preview();
  private planEntity!: Entity;
  readonly hands: Record<Side, HandAim> = { left: new HandAim('left'), right: new HandAim('right') };
  private activeSide: Side = 'right';
  private tools!: Record<string, Tool>;
  toolName: ToolName = 'walls';
  wallTool!: WallTool;
  editTool!: EditTool;
  measureTool!: MeasureTool;
  roomsTool!: RoomsTool;
  pinsTool!: PinsTool;
  captureTool!: CaptureTool;
  menu!: MainMenu;
  keypad!: Keypad;
  private wrist!: WristMenu;
  private sfx = new Sfx();
  private toastLabel = new TextLabel('', { height: 0.045, bg: 'rgba(15,20,30,0.92)' });
  private toolChip = new TextLabel('', { height: 0.028, bg: 'rgba(61,139,255,0.9)' });
  private toastUntil = 0;
  private time = 0;
  private snapEnabled = true;
  private preset: { type: 'door' | 'opening'; width: number; height: number } = { type: 'door', width: 32, height: 80 };
  transform: SavedTransform;
  private axisAngle = 0;
  private raycaster = new Raycaster();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savedAt: string | null = null;
  private restored: boolean;
  private needsAlignWarned = false;
  private heightRepeatAt = 0;
  private flickArmed = true;
  private autoImportTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private surfaceTargets: Record<Side, Object3D> = { left: new Object3D(), right: new Object3D() };
  private uiHover: Record<Side, boolean> = { left: false, right: false };
  /** Smoothed real-surface hit per hand; holds briefly through dropped frames. */
  private surf: Record<Side, { ok: boolean; t: number; p: Vector3; n: Vector3 }> = {
    left: { ok: false, t: -1, p: new Vector3(), n: new Vector3() },
    right: { ok: false, t: -1, p: new Vector3(), n: new Vector3() },
  };
  private meshCache: { key: unknown; pts: PP[] } | null = null;
  private refAnchors!: RefAnchors;
  private probe!: CameraProbe;
  scan!: ScanSession;
  private hybrid!: HybridProbe;
  private anchorLockToasted = false;
  private depthWarned = false;
  /** Corners and midpoints the user hovered, for inference guides (shared by tools). */
  readonly acquired = new Acquired();
  private floor = new FloorFinder();
  private floorT = 0;
  private sessionT0 = -1;
  private floorToasted = false;
  /** Large-space mode: no Quest boundary, walk the whole basement (device setting). */
  largeSpace = (() => {
    try {
      return localStorage.getItem('basement-planner:large-space') !== 'off';
    } catch {
      return true;
    }
  })();
  // Scratch objects (no per-frame allocation).
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private tmpV3 = new Vector3();
  private tmpQ = new Quaternion();
  private eyeV = new Vector3();
  private uiObjs: Object3D[] = [];
  private occluder!: Entity;
  occlusionOn = true;

  /** Filled by PlannerSystem: detected room planes / meshes. */
  planeQuery: (() => Iterable<Entity>) | null = null;
  meshQuery: (() => Iterable<Entity>) | null = null;

  constructor(private world: World) {
    const { plan, restored } = loadSavedPlan();
    this.restored = restored;
    this.store = new PlanStore(plan);
    this.cmd = new CommandBus(this.store);
    this.transform = this.loadTransform();
    this.store.subscribe((p, reason) => this.onPlanChanged(p, reason));
    // Ask the browser not to evict our storage (keeps the plan safe on the headset).
    navigator.storage?.persist?.().catch(() => {});
  }

  init(): void {
    const world = this.world;
    this.view.root.add(this.preview.root);
    this.planEntity = world.createTransformEntity(this.view.root, { parent: world.sceneEntity, persistent: true });
    // Keep the plan attached to IWSDK's persistent scene anchor, so it stays put in the
    // room across sessions when the headset can restore the anchor.
    this.planEntity.addComponent(XRAnchor);
    this.refAnchors = new RefAnchors(world);
    this.scan = new ScanSession(world, this.view.root);
    this.hybrid = new HybridProbe(this.scan.sampler);
    this.probe = new CameraProbe(world, () => this.meshQuery?.() ?? [], () => this.planeQuery?.() ?? []);

    // Real-world hit testing for point-and-capture, one target per hand.
    for (const side of ['left', 'right'] as Side[]) {
      const obj = this.surfaceTargets[side];
      obj.visible = false;
      const e = world.createTransformEntity(obj, { parent: world.sceneEntity, persistent: true });
      e.addComponent(EnvironmentRaycastTarget, { space: side, maxDistance: 8 });
    }

    // Depth occlusion works per material: register every planned-content material
    // through one carrier entity, so walls rebuilt later stay occludable.
    const carrier = new Group();
    const quad = new PlaneGeometry(0.001, 0.001);
    for (const m of [...this.view.occludableMaterials(), ...this.preview.occludableMaterials()]) {
      const mesh = new Mesh(quad, m);
      mesh.visible = false;
      mesh.raycast = () => {};
      carrier.add(mesh);
    }
    this.occluder = world.createTransformEntity(carrier, { parent: world.sceneEntity, persistent: true });
    this.occluder.addComponent(DepthOccludable, { mode: OcclusionShadersMode.MinMaxSoftOcclusion });

    const ctx: CaptureContext = {
      roomMeshPoints: (c, r) => this.roomMeshPoints(c, r),
      store: this.store,
      cmd: this.cmd,
      act: (name, params) => this.act(name, params),
      view: this.view,
      preview: this.preview,
      toast: (m, s) => this.toast(m, s),
      snapOptions: (aim, from) => this.snapOptions(aim, from),
      acquire: (p) => this.acquired.hover(p, this.time),
      openKeypad: (title, initial, onOk) => this.openKeypad(title, initial, onOk),
      openingPreset: () => this.preset,
      refreshUi: () => this.refreshUi(),
    };
    this.wallTool = new WallTool(ctx);
    this.editTool = new EditTool(ctx);
    this.measureTool = new MeasureTool(ctx);
    this.roomsTool = new RoomsTool(ctx);
    this.pinsTool = new PinsTool(ctx);
    this.tools = {
      pins: this.pinsTool,
      rooms: this.roomsTool,
      walls: this.wallTool,
      doors: new OpeningTool(ctx),
      capture: (this.captureTool = new CaptureTool(ctx)),
      edit: this.editTool,
      delete: new DeleteTool(ctx),
      measure: this.measureTool,
      align: new AlignTool(ctx, {
        getTransform: () => this.transform,
        setTransform: (t) => this.setTransform(t),
        anchorReferences: () => this.anchorReferences(),
      }),
      soffit: new SoffitTool(ctx, () => this.axisAngle),
      review: new ScanReviewTool(ctx, this.scan),
    };

    // Browser AI agents (WebMCP) get the same commands, tagged as an assistant.
    registerWebMcp(this.cmd, () => this.refreshUi());

    this.menu = new MainMenu(world, this.menuApi());
    this.menu.panel.feedback = (kind) => this.uiFeedback(kind);
    this.menu.panel.setVisible(false);
    this.keypad = new Keypad(world);
    this.wrist = new WristMenu(world, [this.menu.panel], MENU_H / 2 + 0.045);
    // Toasts trail your view smoothly (SDK Follower) instead of being head-locked.
    const toastEnt = world.createTransformEntity(this.toastLabel.sprite, { parent: world.sceneEntity, persistent: true });
    toastEnt.addComponent(Follower, {
      target: world.player.head,
      offsetPosition: [0, -0.3, -0.9],
      behavior: FollowBehavior.FaceTarget,
      maxAngle: 25,
      tolerance: 0.2,
      speed: 4,
    });
    world.scene.add(this.toolChip.sprite);
    this.toastLabel.sprite.visible = false;
    this.toolChip.sprite.visible = false;
    TextLabel.anisotropy = Math.min(8, world.renderer.capabilities.getMaxAnisotropy());
    this.showToolChip();
    this.uiObjs = [this.menu.panel.backing, this.keypad.panel.backing];

    this.onPlanChanged(this.store.plan, 'load');
    this.applyTransform();
  }

  // ------------------------------------------------------------- menu api ----

  private menuApi(): MenuApi {
    return {
      tool: () => this.toolName,
      setTool: (t) => this.setTool(t),
      toolHint: () => (this.keypad?.open ? 'Enter a value on the keypad' : this.tools[this.toolName].hint()),
      undo: () => this.undo(),
      redo: () => {
        const l = this.store.redo();
        if (l) this.toast(`Redid: ${l}`);
      },
      canUndo: () => this.store.canUndo || this.wallTool.drawing,
      canRedo: () => this.store.canRedo,
      drawing: () => this.wallTool.drawing,
      finishChain: () => this.wallTool.endChain(),
      typeLength: () => this.wallTool.typeLength(),
      hasLastWall: () => !!this.wallTool.lastWall(),
      typeHeight: () => this.wallTool.typeHeight(),
      wallHeight: () => this.store.plan.settings.wallHeight,
      preset: () => this.preset,
      setPreset: (type, width) => {
        this.preset = { type, width, height: 80 };
        this.setTool('doors');
      },
      customWidth: () => this.customWidth(),
      captureProposal: () => !!this.captureTool.proposal,
      acceptCapture: () => this.captureTool.acceptProposal(),
      cancelCapture: () => this.captureTool.cancelProposal(),
      captureThickness: () => this.store.plan.settings.captureThickness,
      setCaptureThickness: (t) =>
        this.act('settings.set', { values: { captureThickness: t } }),
      selectionText: () => this.editTool.describe(),
      selectionKind: () => {
        const k = this.editTool.selection?.kind;
        return k === 'wall' || k === 'opening' || k === 'marker' ? k : null;
      },
      selectedStud: () => this.editTool.selectedWall()?.framing.studSize ?? null,
      editLength: () => this.editTool.typeLength(),
      editHeight: () => this.editTool.typeHeight(),
      editStud: (s) => this.editTool.setStud(s),
      editWidth: () => this.editTool.typeWidth(),
      deleteSelection: () => this.editTool.deleteSelection(),
      edit: (action) => {
        const t = this.editTool;
        if (action === 'thickness') t.typeThickness();
        else if (action === 'split') t.split();
        else if (action === 'kind') t.toggleKind();
        else if (action === 'openingHeight') t.typeOpeningHeight();
        else if (action === 'openingType') t.cycleOpeningType();
        else if (action === 'flip') t.flipDoor();
      },
      openingType: () => {
        const o = this.editTool.selectedOpening();
        return o?.type === 'door' ? 'Door' : o?.type === 'window' ? 'Window' : 'Opening';
      },
      selectedIsReal: () => this.editTool.selectedWall()?.kind === 'existing',
      deselect: () => this.editTool.select(null),
      lastMeasure: () => (this.measureTool.last ? `Last: ${this.measureTool.last}` : ''),
      measureCount: () => this.store.plan.measures.length,
      clearMeasures: () =>
        this.act('measure.clear', {}),
      scanStatus: () => this.scanStatus(),
      importScan: () => this.importScan(false),
      scanning: () => this.scan.scanning,
      toggleScan: () => this.toggleDepthScan(),
      scanProposals: () => this.scan.count(),
      scanReviewing: () => this.scan.reviewing,
      scanKind: (k) => ({ on: this.scan.kinds[k], n: this.scan.total(k) }),
      toggleScanKind: (k) => this.scan.toggleKind(k),
      acceptScan: () => this.acceptDepthScan(),
      discardScan: () => {
        this.scan.discard();
        this.scan.hide();
        this.endReview();
        this.toast('Discarded what the scan found');
      },
      clearScan: () => {
        this.scan.clear();
        this.toast('Scan cleared');
      },
      hasScanMap: () => this.scan.hasMap,
      autoImport: () => this.store.plan.settings.autoImportScan,
      toggleAutoImport: () =>
        this.act('settings.set', { values: { autoImportScan: !this.store.plan.settings.autoImportScan } }),
      cameraTest: () => this.runCameraTest(),
      cameraTestRunning: () => this.probe.running || this.hybrid.running,
      hasRefs: () => !!this.store.plan.reference,
      resetRefs: () => this.resetReference(),
      viewMode: () => this.view.mode,
      setViewMode: (m) => this.view.setMode(m as WallViewMode),
      viewModes: () => [
        { id: 'ghost', label: 'Ghost' },
        { id: 'solid', label: 'Solid' },
        { id: 'xray', label: 'X-ray' },
      ],
      viewText: () => {
        if (this.view.mode !== 'xray') return 'Display';
        const f = summarizeFraming(generateFraming(this.store.plan));
        return `Framing: ${f.studs} studs, ${f.plateFeet.toFixed(0)} ft of plate, ${f.headers} headers`;
      },
      realWalls: () => this.store.plan.settings.realWalls,
      cycleRealWalls: () => {
        const order = ['shown', 'outline', 'hidden'] as const;
        const next = order[(order.indexOf(this.store.plan.settings.realWalls) + 1) % 3];
        this.act('settings.set', { values: { realWalls: next } });
        this.toast(next === 'shown' ? 'Real walls shown' : next === 'outline' ? 'Real walls as outlines' : 'Real walls hidden (still used for snapping and rooms)', 3);
      },
      occlusion: () => this.occlusionOn,
      toggleOcclusion: () => this.toggleOcclusion(),
      labels: () => this.view.showLabels,
      toggleLabels: () => (this.view.showLabels = !this.view.showLabels),
      snap: () => this.snapEnabled,
      toggleSnap: () => this.toggleSnap(),
      pinned: () => !!this.wrist?.pinned,
      togglePin: () => this.wrist.togglePin(),
      menuMode: () => this.wrist?.mode ?? 'wrist',
      cycleMenuMode: () => this.cycleMenuMode(),
      exit: () => this.world.exitXR(),
      extraTabs: [this.roomsTab(), this.pinsTab(), this.ceilingTab()],
    };
  }

  private ceilingTab(): NonNullable<MenuApi['extraTabs']>[number] {
    const room = () => this.roomsTool.selectedRoom() ?? null;
    const type = (t: CeilingType, label: string) => ({
      id: `ceil-${t}`,
      label: () => label,
      onClick: () => {
        this.setCeiling({ type: t }, true);
        if (!this.hasFloorArea()) this.toast('Scan the basement (Room tab) or draw a few walls so the ceiling knows where it goes', 5);
      },
      active: () => roomCeiling(this.store.plan, room()).type === t,
    });
    return {
      name: 'ceiling',
      label: 'Ceiling',
      icon: 'height',
      tiles: [{ id: 'soffit', icon: 'walls', label: () => 'Soffit', tool: 'soffit' }],
      text: () => {
        const r = room();
        const c = roomCeiling(this.store.plan, r);
        return `${r ? r.name : 'Whole basement'}: ${CEILING_NAMES[c.type]}, ${formatLength(c.height)}`;
      },
      rows: [
        [type('drywall', 'Drywall'), type('drop', 'Drop'), type('open', 'Open joists'), {
          id: 'ceil-show',
          label: () => (this.store.plan.settings.showCeiling ? 'Shown' : 'Hidden'),
          icon: 'eye',
          onClick: () =>
            this.act('settings.set', { values: { showCeiling: !this.store.plan.settings.showCeiling } }),
          active: () => this.store.plan.settings.showCeiling,
        }],
        [
          { id: 'ceil-h', label: () => 'Height', icon: 'height', onClick: () => this.typeCeilingHeight() },
          {
            id: 'ceil-default',
            label: () => 'Use default',
            span: 2,
            onClick: () => this.setCeiling({ type: null, height: null }),
            visible: () => !!room() && (room()!.ceilingType !== null || room()!.ceilingHeight !== null),
          },
          { id: 'ceil-whole', col: 3, label: () => 'Whole', onClick: () => this.roomsTool.select(null), active: () => !room() },
        ],
        [
          {
            id: 'soffit-h',
            label: () => `Soffit bottom ${formatLength(this.store.plan.settings.soffitBottom)}`,
            icon: 'keypad',
            span: 3,
            onClick: () =>
              this.openKeypad('Soffit bottom height', this.store.plan.settings.soffitBottom, (h) =>
                this.act('settings.set', { values: { soffitBottom: h } }),
              ),
          },
        ],
      ],
    };
  }

  /** Run a command; if it's refused, say why. */
  act<N extends CommandName>(name: N, params: ParamsOf<N>): ResultOf<N> | null {
    const r = this.cmd.exec(name, params);
    if (r.ok) return r.value;
    this.toast(r.error, 3);
    return null;
  }

  /** Change the ceiling of the selected room, or the plan default when no room is selected. */
  private setCeiling(patch: { type?: CeilingType | null; height?: number | null }, _show = false): void {
    const r = this.roomsTool.selectedRoom();
    this.act('ceiling.set', { roomId: r?.id ?? null, ...patch });
  }

  private typeCeilingHeight(): void {
    const c = roomCeiling(this.store.plan, this.roomsTool.selectedRoom());
    this.openKeypad(this.roomsTool.selectedRoom() ? 'Room ceiling height' : 'Ceiling height', c.height, (h) => {
      if (h < 60 || h > 180) {
        this.toast('Ceiling height should be between 5 and 15 ft');
        return;
      }
      this.setCeiling({ height: h });
    });
  }

  private pinsTab(): NonNullable<MenuApi['extraTabs']>[number] {
    const short: Record<string, string> = { 'water-heater': 'Water htr' };
    const chip = (t: (typeof MARKER_TYPES)[number]) => ({
      id: `pin-${t}`,
      label: () => short[t] ?? MARKER_INFO[t].name.replace('Electrical panel', 'Panel').replace('Floor drain', 'Drain'),
      onClick: () => {
        this.pinsTool.type = t;
        this.setTool('pins');
      },
      active: () => this.pinsTool.type === t,
    });
    const T = MARKER_TYPES;
    return {
      name: 'pins',
      label: 'Pins',
      icon: 'pin',
      defaultTool: 'pins',
      tiles: [],
      text: () => `${this.store.plan.markers.length} pins placed`,
      rows: [
        [chip(T[0]), chip(T[1]), chip(T[2]), chip(T[3])],
        [chip(T[4]), chip(T[5]), chip(T[6]), chip(T[7])],
        [chip(T[8])],
      ],
    };
  }

  private roomsTab(): NonNullable<MenuApi['extraTabs']>[number] {
    const rt = () => this.roomsTool;
    const has = () => !!rt().selectedRoom();
    const name = (n: string) => ({
      id: `room-${n.toLowerCase()}`,
      label: () => n,
      onClick: () => rt().setName(n),
      active: () => rt().selectedRoom()?.name === n,
      visible: has,
    });
    const finish = (f: Finish, label: string) => ({
      id: `finish-${f}`,
      label: () => (f === 'none' && has() ? 'Same' : label),
      onClick: () => {
        if (has()) {
          rt().setFinish(f);
          this.toast(`${rt().selectedRoom()?.name ?? 'Room'}: ${FINISH_NAMES[f]}`, 2);
        } else {
          this.toast(`Whole floor: ${FINISH_NAMES[f]}`, 2);
          this.act('settings.set', { values: { floorFinish: f } });
          if (!this.hasFloorArea()) this.toast('Scan the basement (Room tab) or draw a few walls so the floor knows where it goes', 5);
        }
      },
      active: () => (has() ? rt().selectedRoom()?.finish === f : this.store.plan.settings.floorFinish === f),
    });
    return {
      name: 'rooms',
      label: 'Rooms',
      icon: 'rooms',
      defaultTool: 'rooms',
      tiles: [],
      text: () => (has() ? rt().describe() : `Whole floor: ${FINISH_NAMES[this.store.plan.settings.floorFinish]} (tap a room to set just it)`),
      rows: [
        [name('Bedroom'), name('Office'), name('Family'), name('Bath')],
        [name('Gym'), name('Storage'), name('Utility'), name('Laundry')],
        [finish('carpet', 'Carpet'), finish('lvp', 'LVP'), finish('tile', 'Tile'), finish('concrete', 'Concrete')],
        [
          finish('epoxy', 'Epoxy'),
          finish('none', 'None'),
          { id: 'room-whole', label: () => 'Whole floor', onClick: () => rt().select(null), active: () => !has() },
          { id: 'room-remove', label: () => 'Remove', icon: 'trash', tone: 'danger', onClick: () => rt().remove(), visible: has },
        ],
      ],
    };
  }

  private uiFeedback(kind: 'hover' | 'click'): void {
    // Rumble whichever controller is pointing at the menu.
    for (const side of ['left', 'right'] as Side[]) {
      if (this.uiHover[side]) this.hands[side].pulse(this.world, kind === 'click' ? 0.45 : 0.15, kind === 'click' ? 25 : 10);
    }
    if (kind === 'click') this.sfx.click();
    else this.sfx.tick();
  }

  // ---------------------------------------------------------------- UI ----

  private refreshUi(): void {
    this.menu?.panel.refresh();
    for (const l of this.listeners) l();
  }

  setTool(name: ToolName): void {
    if (!this.tools[name]) return;
    if (name !== this.toolName) {
      this.tools[this.toolName].deactivate();
      this.toolName = name;
    }
    this.tools[name].activate();
    this.preview.clear();
    this.view.setHighlight(null);
    this.menu?.syncTab(name);
    this.showToolChip();
    this.refreshUi();
  }

  /** Wrist -> Float (follows your view) -> Pinned (stays in the room). */
  private cycleMenuMode(): void {
    const order = ['wrist', 'float', 'pinned'] as const;
    const next = order[(order.indexOf(this.wrist.mode) + 1) % order.length];
    const ent = this.menu.panel.entity;
    if (ent.hasComponent(Follower)) ent.removeComponent(Follower);
    if (next === 'float') {
      ent.addComponent(Follower, {
        target: this.world.player.head,
        offsetPosition: [0, -0.2, -0.55],
        behavior: FollowBehavior.PivotY,
        maxAngle: 40,
        tolerance: 0.3,
        speed: 2,
      });
    }
    this.wrist.mode = next;
    this.toast(next === 'wrist' ? 'Menu on your left wrist' : next === 'float' ? 'Menu floats in front of you' : 'Menu pinned here');
  }

  private runCameraTest(): void {
    if (this.probe.running || this.hybrid.running) return;
    this.toast('Camera test: allow the camera if asked', 4);
    this.probe
      .run((m) => this.toast(m, 4))
      .then(async (r) => {
        // Then: WebGPU fusion beside this WebGL session (~20 s).
        this.toast('GPU scanning test: look around for 20 seconds', 6);
        const extra = await this.hybrid.start();
        r.rows.push(...extra);
        try {
          localStorage.setItem(PROBE_KEY, JSON.stringify({ ...r, thumb: null }));
          localStorage.setItem(PROBE_KEY, JSON.stringify(r));
        } catch {
          /* thumbnail too large: the copy without it stays */
        }
        const v = extra.find((x) => x.name === 'Verdict');
        if (v) this.toast(`GPU scanning: ${v.detail}`, 6);
        const fails = r.rows.filter((x) => x.ok === false).length;
        const cam = r.rows.find((x) => x.name === 'Camera stream during AR');
        this.toast(
          cam?.ok
            ? `Camera works in AR (${r.rows.find((x) => x.name === 'Frame rate')?.detail ?? ''}). Full results on the flat page.`
            : `Camera test: ${fails} checks failed. Exit AR to see the results.`,
          8,
        );
        this.refreshUi();
      });
  }

  private toggleOcclusion(): void {
    this.occlusionOn = !this.occlusionOn;
    if (this.occlusionOn) this.occluder.addComponent(DepthOccludable, { mode: OcclusionShadersMode.MinMaxSoftOcclusion });
    else this.occluder.removeComponent(DepthOccludable);
    setSurfaceOcclusion(this.occlusionOn);
    this.toast(this.occlusionOn ? 'Real objects hide planned walls' : 'Planned walls always on top');
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
    const root = this.keypad.panel.root;
    root.position.copy(head).addScaledVector(fwd, 0.45);
    root.position.y -= 0.25;
    root.rotation.set(-0.5, Math.atan2(-fwd.x, -fwd.z), 0, 'YXZ');
    // Keep it in front of you if you turn while typing.
    if (!this.keypad.panel.entity.hasComponent(Follower)) {
      this.keypad.panel.entity.addComponent(Follower, {
        target: this.world.player.head,
        offsetPosition: [0, -0.25, -0.45],
        behavior: FollowBehavior.PivotY,
        maxAngle: 35,
        tolerance: 0.25,
        speed: 3,
      });
    }
    this.refreshUi();
  }

  toast(msg: string, seconds = 3): void {
    this.toastLabel.setText(msg);
    this.toastLabel.sprite.visible = true;
    this.toastUntil = this.time + seconds;
  }

  private showToolChip(): void {
    this.toolChip.setText(TOOL_LABEL[this.toolName]);
  }

  private undo(): void {
    if (this.tools[this.toolName].undo?.()) {
      this.refreshUi();
      return;
    }
    const label = this.store.undo();
    this.toast(label ? `Undid: ${label}` : 'Nothing to undo');
  }

  private resetReference(): void {
    this.refAnchors.forget();
    this.act('reference.set', { reference: null });
    this.setTool('align');
    this.toast('Click two real floor corners to set new references');
  }

  // ------------------------------------------------------- plan + frame ----

  private onPlanChanged(plan: Plan, _reason: string): void {
    this.view.rebuild(plan);
    this.axisAngle = primaryAxis(plan);
    this.editTool?.validate();
    this.roomsTool?.validate();
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
    for (const l of this.listeners) l();
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

  setTransform(t: PlanTransform): void {
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
      const tool = this.tools[this.toolName];
      const dragMode = tool.inputMode?.() === 'drag';
      this.hands.left.dragMode = dragMode;
      this.hands.right.dragMode = dragMode;
      this.hands.left.update(world, time);
      this.hands.right.update(world, time);
      this.updateSurfaces(time);
      this.scan.tick(time);
      this.hybrid.tick(time);
      this.updateFloor(time);
      if (this.scan.scanning && this.scan.depthOk === false && !this.depthWarned) {
        this.depthWarned = true;
        this.toast('Depth is not available on this device, so scanning cannot work here', 6);
      }
      this.updateRefAnchors();
      this.handleButtons(time);
      if (!this.keypad.open && this.keypad.panel.entity.hasComponent(Follower)) this.keypad.panel.entity.removeComponent(Follower);
      this.wrist.update();
      this.updatePokeMode(time);
      this.menu.panel.tick(delta);
      this.handleTool();
      this.updateToolChip();
    }

    if (!inXR) this.sessionT0 = -1;
    updateSurfaceOcclusion(world);
    this.view.updateLabels(world.camera);
    this.updateToast();
  }

  /**
   * Keep the plan floor on the real floor. Runs for the first seconds of every
   * session (and slowly after), from depth below the eyes and floor hit tests.
   */
  private updateFloor(time: number): void {
    if (this.sessionT0 < 0) {
      this.sessionT0 = time;
      this.floor.reset();
      this.floorToasted = false;
    }
    const early = time - this.sessionT0 < 12;
    if (time - this.floorT < (early ? 0.4 : 3)) return;
    this.floorT = time;
    const eye = this.world.camera.getWorldPosition(this.eyeV);
    const eyeY = eye.y;
    // Floor hit tests count too (pointing at the floor), heavily weighted.
    for (const side of ['left', 'right'] as Side[]) {
      const o = this.surfaceTargets[side];
      if (!o.visible) continue;
      this.tmpV.set(0, 1, 0).applyQuaternion(o.getWorldQuaternion(this.tmpQ));
      if (this.tmpV.y > 0.95) for (let i = 0; i < 20; i++) this.floor.add(o.getWorldPosition(this.tmpV2).y, eyeY);
    }
    const f = this.floor;
    this.scan.sampler.sample((_x, y) => f.add(y, eyeY), 2);
    const fy = f.solve();
    if (fy === null) return;
    const parent = this.view.root.parent;
    if (!parent) return;
    parent.updateWorldMatrix(true, false);
    const local = parent.worldToLocal(this.tmpV3.set(eye.x, fy, eye.z)).y;
    if (Math.abs(local - this.transform.floorY) > 0.01) {
      this.transform.floorY = local;
      this.applyTransform();
      this.storeTransform();
      if (!this.floorToasted && this.largeSpace) {
        this.floorToasted = true;
        this.toast('Found the floor', 2);
      }
    }
  }

  setLargeSpace(on: boolean): void {
    this.largeSpace = on;
    try {
      localStorage.setItem('basement-planner:large-space', on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }

  private pokeCheckT = 0;
  /** Finger poking on the menu only with tracked hands (see ui/poke.ts). */
  private updatePokeMode(time: number): void {
    if (time - this.pokeCheckT < 0.5) return;
    this.pokeCheckT = time;
    const srcs = this.world.session?.inputSources;
    if (!srcs) return;
    let hands = false;
    for (const s of srcs) if (s.hand) hands = true;
    setPokeEnabled(hands);
  }

  /** Two persistent anchors on the reference corners keep the plan locked to the room. */
  private anchorReferences(): void {
    const ref = this.store.plan.reference;
    if (!ref) return;
    const root = this.view.root;
    root.updateWorldMatrix(true, false);
    const w1 = root.localToWorld(planToLocal(ref.r1));
    const w2 = root.localToWorld(planToLocal(ref.r2));
    this.refAnchors.place(w1, w2);
  }

  private updateRefAnchors(): void {
    const ref = this.store.plan.reference;
    if (!ref || !this.refAnchors.update()) return;
    const parent = this.view.root.parent;
    if (!parent) return;
    const [w1, w2] = this.refAnchors.localPositions(parent);
    const sol = solveTwoPoint(ref.r1, ref.r2, w1, w2);
    if (!sol) return;
    const t = this.transform;
    const moveIn = Math.hypot(sol.transform.tx - t.tx, sol.transform.tz - t.tz) / INCH_M;
    const turn = Math.abs(sol.transform.theta - t.theta);
    // Ignore sub-quarter-inch jitter; correct anything bigger (session start, drift).
    if (moveIn > 0.25 || turn > 0.0015) {
      this.setTransform(sol.transform);
      if (!this.anchorLockToasted) {
        this.anchorLockToasted = true;
        this.toast('Plan locked to your reference corners', 3);
      }
    }
    this.needsAlignWarned = true; // the corners are tracked; no need to warn about the scene anchor
  }

  private checkAnchor(): void {
    if (!this.world.session || this.needsAlignWarned) return;
    const uuid = this.currentAnchorUuid();
    if (!uuid) return;
    if (!this.transform.anchorUuid) {
      this.transform.anchorUuid = uuid;
      this.storeTransform();
    } else if (this.transform.anchorUuid !== uuid && this.store.plan.walls.length) {
      this.needsAlignWarned = true;
      this.toast(
        this.store.plan.reference
          ? 'Room anchor changed. Use Room > Align and click Ref 1 then Ref 2.'
          : 'Room anchor changed. Plan may be offset: set reference corners with Room > Align.',
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
    if (L.buttonDown(InputComponent.X_Button, w)) this.wrist.hiddenByUser = !this.wrist.hiddenByUser;
    if (R.isHand) return;
    // Right thumbstick: up/down = wall height (Walls tool), left/right flick = next tool.
    const pad = w.input.xr.gamepads.right;
    const axes = pad?.getAxesValues(InputComponent.Thumbstick);
    const x = axes?.x ?? 0;
    const y = axes?.y ?? 0;
    if (Math.abs(x) > 0.75 && Math.abs(x) > Math.abs(y)) {
      if (this.flickArmed) {
        this.flickArmed = false;
        const i = TOOL_CYCLE.indexOf(this.toolName);
        const next = TOOL_CYCLE[(Math.max(0, i) + (x > 0 ? 1 : TOOL_CYCLE.length - 1)) % TOOL_CYCLE.length];
        this.setTool(next);
        R.pulse(w, 0.3, 20);
        this.sfx.tick();
      }
    } else if (Math.abs(x) < 0.3) {
      this.flickArmed = true;
    }
    if (this.toolName === 'walls' && Math.abs(y) > 0.6 && Math.abs(y) > Math.abs(x) && time >= this.heightRepeatAt) {
      const h = Math.max(24, this.store.plan.settings.wallHeight + (y < 0 ? 1 : -1));
      this.wallTool.applyHeight(h);
      this.heightRepeatAt = time + 0.12;
    }
  }

  private isShown(o: Object3D): boolean {
    for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  private rayHitsUI(h: HandAim): boolean {
    this.raycaster.set(h.origin, h.dir);
    this.raycaster.far = 5;
    for (const o of this.uiObjs) {
      if (!this.isShown(o)) continue;
      if (this.raycaster.intersectObject(o, false).length) return true;
    }
    return false;
  }

  private handleTool(): void {
    const tool = this.tools[this.toolName];
    const modal = this.keypad.open;

    for (const side of ['left', 'right'] as Side[]) {
      const h = this.hands[side];
      this.uiHover[side] = h.tracked && this.rayHitsUI(h);
      if (!h.tracked) continue;
      if (h.selectStarted) {
        h.pressOnUI = this.uiHover[side] || modal;
        if (!h.pressOnUI) {
          this.activeSide = side;
          tool.pressStart?.(this.computeAim(h));
        }
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

    const aimingUI = modal || this.uiHover[active.side];
    const pressingTool = active.phase !== 'idle' && !active.pressOnUI;
    if (pressingTool && tool.drag) {
      tool.drag(this.computeAim(active));
    } else {
      tool.hover(active.tracked && !aimingUI && !active.pressOnUI ? this.computeAim(active) : null);
    }

    for (const side of ['left', 'right'] as Side[]) {
      const h = this.hands[side];
      if (!h.selectEnded) continue;
      if (!h.pressOnUI && side === this.activeSide && !modal) {
        tool.commit(this.computeAim(h));
        this.refreshUi();
      }
      h.finishPress();
    }
  }

  /**
   * Hit-test results flicker: some frames have no hit, and the normal is noisy.
   * Keep the last hit for a moment and low-pass the point and normal.
   */
  private updateSurfaces(time: number): void {
    for (const side of ['left', 'right'] as Side[]) {
      const t = this.surfaceTargets[side];
      const sf = this.surf[side];
      if (t.visible) {
        const p = t.getWorldPosition(this.tmpV);
        const n = this.tmpV2.set(0, 1, 0).applyQuaternion(t.getWorldQuaternion(this.tmpQ));
        if (!sf.ok || sf.p.distanceTo(p) > 0.15) {
          sf.p.copy(p);
          sf.n.copy(n);
        } else {
          sf.p.lerp(p, 0.45);
          sf.n.lerp(n, 0.25).normalize();
        }
        sf.ok = true;
        sf.t = time;
      } else if (sf.ok && time - sf.t > 0.35) {
        sf.ok = false;
      }
    }
  }

  /** Room-mesh vertices (plan inches) within `radius` of a point, or null when there's no room mesh. */
  private roomMeshPoints(center: Vec2, radius: number): PP[] | null {
    let mesh: Entity | null = null;
    let best = 0;
    for (const e of this.meshQuery?.() ?? []) {
      if (e.getValue(XRMesh, 'isBounded3D')) continue;
      const raw = e.getValue(XRMesh, '_mesh') as unknown as { vertices?: Float32Array } | undefined;
      const n = raw?.vertices?.length ?? 0;
      if (n > best) {
        best = n;
        mesh = e;
      }
    }
    if (!mesh || best < 30) {
      if (!this.scan?.hasMap) return null;
      const pts = this.scan.points().filter((p) => Math.hypot(p.x - center.x, p.y - center.y) <= radius);
      return pts.length >= 30 ? pts : null;
    }
    const raw = mesh.getValue(XRMesh, '_mesh') as unknown as { vertices: Float32Array };
    const root = this.view.root;
    const key = `${best}|${this.transform.theta}|${this.transform.tx}|${this.transform.tz}|${this.transform.floorY}`;
    if (!this.meshCache || this.meshCache.key !== raw.vertices || (this.meshCache as { k2?: string }).k2 !== key) {
      const obj = mesh.object3D!;
      obj.updateWorldMatrix(true, false);
      root.updateWorldMatrix(true, false);
      const v = raw.vertices;
      const pts: PP[] = [];
      const w = new Vector3();
      for (let i = 0; i < v.length; i += 3) {
        w.set(v[i], v[i + 1], v[i + 2]);
        obj.localToWorld(w);
        root.worldToLocal(w);
        pts.push({ x: w.x / INCH_M, y: w.z / INCH_M, z: w.y / INCH_M });
      }
      this.meshCache = { key: raw.vertices, pts };
      (this.meshCache as { k2?: string }).k2 = key;
    }
    return this.meshCache.pts.filter((p) => Math.hypot(p.x - center.x, p.y - center.y) <= radius);
  }

  private aimHit: AimHit = {
    floor: null,
    floorDistM: 0,
    wall: null,
    marker: null,
    surface: null,
    ceiling: null,
    fine: false,
    pressing: false,
    eye: { x: 0, y: 0 },
  };

  /** Build the aim for a hand. The returned object is reused; tools must not keep it. */
  private computeAim(h: HandAim): AimHit {
    const root = this.view.root;
    root.updateWorldMatrix(true, false);
    // Ray into plan-root local space.
    const o = root.worldToLocal(this.tmpV.copy(h.aimOrigin));
    root.getWorldQuaternion(this.tmpQ).invert();
    const d = this.tmpV2.copy(h.aimDir).applyQuaternion(this.tmpQ);
    const a = this.aimHit;
    a.floor = null;
    a.floorDistM = 0;
    a.ceiling = null;
    if (d.y < -0.02) {
      const t = -o.y / d.y;
      if (t > 0 && t < 20) {
        a.floor = { x: (o.x + d.x * t) / INCH_M, y: (o.z + d.z * t) / INCH_M };
        a.floorDistM = t;
      }
    } else if (d.y > 0.02) {
      const ceilM = this.store.plan.settings.wallHeight * INCH_M;
      const t = (ceilM - o.y) / d.y;
      if (t > 0 && t < 20) a.ceiling = { x: (o.x + d.x * t) / INCH_M, y: (o.z + d.z * t) / INCH_M };
    }
    // Planned and scanned walls, in world space.
    a.wall = null;
    this.raycaster.set(h.aimOrigin, h.aimDir);
    this.raycaster.far = 20;
    const hit = this.raycaster.intersectObjects(this.view.wallMeshes, false)[0];
    if (hit) {
      const lp = root.worldToLocal(this.tmpV3.copy(hit.point));
      a.wall = {
        wallId: hit.object.userData.wallId as string,
        point: { x: lp.x / INCH_M, y: lp.z / INCH_M },
        z: lp.y / INCH_M,
        distM: hit.distance,
      };
    }
    a.marker = null;
    if (this.view.markerMeshes.length) {
      const mh = this.raycaster.intersectObjects(this.view.markerMeshes, false)[0];
      if (mh) a.marker = { id: mh.object.userData.markerId as string, distM: mh.distance };
    }
    // Real-world surface from the headset hit test (smoothed, see updateSurfaces).
    a.surface = null;
    const sf = this.surf[h.side];
    if (sf.ok) {
      const dist = sf.p.distanceTo(h.aimOrigin);
      const p = root.worldToLocal(this.tmpV3.copy(sf.p));
      const px = p.x;
      const py = p.y;
      const pz = p.z;
      root.getWorldQuaternion(this.tmpQ).invert();
      const n = this.tmpV3.copy(sf.n).applyQuaternion(this.tmpQ);
      a.surface = { p: { x: px / INCH_M, y: pz / INCH_M }, z: py / INCH_M, n: { x: n.x, y: n.z }, ny: n.y, distM: dist };
    }
    const eye = root.worldToLocal(this.world.camera.getWorldPosition(this.eyeV));
    a.eye = { x: eye.x / INCH_M, y: eye.z / INCH_M };
    a.fine = h.phase === 'fine';
    a.pressing = h.phase !== 'idle';
    return a;
  }

  private snapOptions(aim: AimHit, from?: Vec2): SnapOptions {
    const st = this.store.plan.settings;
    // ~3 degrees of arc at the aim distance, clamped to 2-10 inches: easy to hit with a hand or controller.
    const tolIn = Math.min(10, Math.max(2, (Math.tan((3 * Math.PI) / 180) * aim.floorDistM) / INCH_M));
    return {
      ...defaultSnapOptions,
      tolerance: aim.fine ? 1.25 : tolIn,
      acquired: this.acquired.points(),
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
  }

  /** Small tool name floating above the drawing hand. */
  private updateToolChip(): void {
    const h = this.hands[this.activeSide];
    const s = this.toolChip.sprite;
    s.visible = h.tracked && !this.uiHover[h.side] && !this.menu.panel.visible;
    if (!s.visible) return;
    s.position.copy(h.origin);
    s.position.y += 0.08;
  }

  // ------------------------------------------------------------- scan ----

  private toggleDepthScan(): void {
    const s = this.scan;
    if (!s.scanning) {
      this.depthWarned = false;
      s.livePlan = this.store.plan;
      void s.start();
      this.toast('Scanning: walk slowly and look at every wall, the ceiling and the floor', 6);
      return;
    }
    s.stop();
    const root = this.view.root;
    root.updateWorldMatrix(true, false);
    const e = root.worldToLocal(this.world.camera.getWorldPosition(this.eyeV));
    this.toast('Finding walls...', 2);
    void s.analyze(this.store.plan, { x: e.x / INCH_M, y: e.z / INCH_M }).then((res) => this.showScanResult(res));
  }

  private showScanResult(res: StructureResult): void {
    const s = this.scan;
    const n = s.count();
    if (!s.reviewing && res.footprint) {
      // Nothing new to review, but the floor area is still worth keeping.
      this.cmd.run('scan.applyStructure', { result: { ...res, walls: [], soffits: [], posts: [] } }, 'scan');
      s.discard();
      s.hide();
      this.toast('No new walls found. Saved the scanned floor area for the floor and ceiling.', 5);
      return;
    }
    if (!s.reviewing) {
      this.toast(s.map.size < 500 ? 'Not enough was seen yet. Scan again and look around more.' : 'No new walls or ceiling features found', 5);
      return;
    }
    const parts = [`${res.walls.length} walls`];
    if (res.soffits.length) parts.push(`${res.soffits.length} low areas`);
    if (res.posts.length) parts.push(`${res.posts.length} possible posts (off)`);
    if (res.ceiling) parts.push(`ceiling ${formatLength(res.ceiling - (res.floorOffset ?? 0))}`);
    this.toast(`Found ${parts.join(', ')}. Click items to skip them, then Add.`, 7);
    this.reviewReturn = this.toolName === 'review' ? 'walls' : this.toolName;
    this.setTool('review');
  }

  private hasFloorArea(): boolean {
    const p = this.store.plan;
    return !!p.footprint?.rows.length || p.nodes.length >= 3 || findRoomFaces(p).length > 0;
  }

  private reviewReturn: ToolName = 'walls';

  private endReview(): void {
    if (this.toolName === 'review') this.setTool(this.reviewReturn);
  }

  private acceptDepthScan(): void {
    const res = this.scan.chosen();
    if (!res) return;
    // Settle the floor first so heights match.
    if (res.floorOffset && Math.abs(res.floorOffset) <= 8) {
      this.transform.floorY += res.floorOffset * INCH_M;
      this.applyTransform();
      this.storeTransform();
    }
    this.cmd.run('scan.applyStructure', { result: res }, 'scan');
    const n = this.scan.count();
    this.scan.discard();
    this.scan.hide();
    this.endReview();
    this.toast(`Added ${n} items from the scan`, 4);
  }

  private scanStatus(): string {
    if (this.scan?.scanning) {
      const k = this.scan.map.size;
      return k < 200 ? 'Scanning... look around' : `Scanning: ${(k / 1000).toFixed(1)}k points`;
    }
    if (this.scan?.reviewing) return 'Click an item to skip it. Green walls, orange low areas, yellow posts';
    const p = this.store.plan;
    const scanned = p.walls.filter((w) => w.kind === 'existing' && w.source !== 'capture').length;
    const captured = p.walls.filter((w) => w.source === 'capture').length;
    const objs = p.obstacles.length;
    if (!scanned && !captured && !objs) return 'No room scan yet';
    return `${scanned} scanned walls, ${captured} captured, ${objs} objects`;
  }

  /** Called by the system when room planes/meshes appear or change. */
  scheduleAutoImport(): void {
    if (!this.store.plan.settings.autoImportScan) return;
    if (this.autoImportTimer) clearTimeout(this.autoImportTimer);
    this.autoImportTimer = setTimeout(() => this.importScan(true), 1500);
  }

  /** Read Space Setup walls, floor, ceiling and objects. `auto` skips unchanged scans. */
  importScan(auto: boolean): void {
    if (auto && !this.store.plan.settings.autoImportScan) return;
    const planes: ScanPlane[] = [];
    for (const e of this.planeQuery?.() ?? []) {
      const raw = e.getValue(XRPlane, '_plane') as unknown as { semanticLabel?: string; polygon?: DOMPointReadOnly[] };
      const obj = e.object3D;
      if (!raw || !obj) continue;
      obj.updateWorldMatrix(true, false);
      const points = (raw.polygon ?? []).map((p) => obj.localToWorld(new Vector3(p.x, p.y, p.z)));
      planes.push({ label: raw.semanticLabel ?? '', points });
    }
    const boxes: ScanBox[] = [];
    for (const e of this.meshQuery?.() ?? []) {
      if (!e.getValue(XRMesh, 'isBounded3D')) continue;
      const obj = e.object3D;
      if (!obj) continue;
      obj.updateWorldMatrix(true, false);
      const mn = e.getVectorView(XRMesh, 'min');
      const mx = e.getVectorView(XRMesh, 'max');
      const corners: P3[] = [];
      for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]]) {
        corners.push(obj.localToWorld(new Vector3(x, y, z)));
      }
      boxes.push({ label: (e.getValue(XRMesh, 'semanticLabel') as string) ?? '', corners });
    }
    if (!planes.length && !boxes.length) {
      if (!auto) this.toast('No room scan found. Run Space Setup in Quest settings, then try again.', 6);
      return;
    }
    const root = this.view.root;
    root.updateWorldMatrix(true, false);
    const st = this.store.plan.settings;
    const toPlan = (w: P3) => {
      const l = root.worldToLocal(new Vector3(w.x, w.y, w.z));
      return { p: { x: l.x / INCH_M, y: l.z / INCH_M }, y: l.y };
    };
    const res = wallsFromScan(planes, toPlan, st.foundationThickness);
    const objects = obstaclesFromScan(boxes, toPlan, res.floorY ?? 0);
    const sig = scanSignature(res.walls, objects);
    if (auto && (sig === st.scanSignature || (!res.walls.length && !objects.length))) return;

    if (res.floorY !== null && Math.abs(res.floorY) < 0.3 && Math.abs(res.floorY) > 0.003) {
      this.transform.floorY += res.floorY;
      this.applyTransform();
      this.storeTransform();
    }
    const ceilingIn =
      res.ceilingY !== null && res.floorY !== null ? Math.round(((res.ceilingY - res.floorY) / INCH_M) * 4) / 4 : null;
    const goodCeiling = ceilingIn !== null && ceilingIn > 60 && ceilingIn < 180;
    this.cmd.run('scan.importRoom', { scan: { walls: res.walls, objects, ceiling: goodCeiling ? ceilingIn : null, signature: sig } }, 'scan');
    this.toast(
      `${auto ? 'Room scan loaded' : 'Imported'}: ${res.walls.length} walls, ${objects.length} objects${
        goodCeiling ? `, ceiling ${formatLength(ceilingIn!)}` : ''
      }`,
      5,
    );
  }

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
    this.world.launchXR(
      this.largeSpace ? undefined : { referenceSpace: { type: 'local-floor' as never, required: false, fallbackOrder: ['local' as never, 'viewer' as never] } },
    );
  }

  loadPlan(plan: Plan): void {
    this.wallTool.endChain();
    this.editTool.select(null);
    this.store.load(plan);
  }
}
