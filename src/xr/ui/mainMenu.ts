import type { World } from '@iwsdk/core';
import type { IconName } from './icons.js';
import { chipRenderer, roundRenderer, SpatialPanel, tabRenderer, textRenderer, tileRenderer, THEME } from './spatialPanel.js';

export type TabName = 'room' | 'edit' | 'measure' | 'view';
export type ToolName = 'walls' | 'trace' | 'doors' | 'edit' | 'delete' | 'measure' | 'align';

/** Everything the menu needs from the app. */
export interface MenuApi {
  tool(): ToolName;
  setTool(t: ToolName): void;
  toolHint(): string;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  // room
  roomStatus(): string;
  importSpaceSetup(): void;
  scanning(): boolean;
  toggleScan(): void;
  checkWalls(): void;
  hasRoomMesh(): boolean;
  clearScan(): void;
  startOver(): void;
  startOverArmed(): boolean;
  // draw and edit
  drawing(): boolean;
  finishChain(): void;
  typeLength(): void;
  hasLastWall(): boolean;
  preset(): { type: 'door' | 'opening'; width: number };
  /** Door tool measures real doorways on the scan. */
  measureDoors(): boolean;
  setMeasureDoors(): void;
  setPreset(type: 'door' | 'opening', width: number): void;
  customWidth(): void;
  selectionKind(): 'wall' | 'opening' | null;
  selectedIsReal(): boolean;
  snapSelected(): void;
  editLength(): void;
  editThickness(): void;
  editWidth(): void;
  editOpeningHeight(): void;
  openingType(): string;
  cycleOpeningType(): void;
  flipDoor(): void;
  toggleKind(): void;
  selectedLocked(): boolean;
  toggleLock(): void;
  deleteSelection(): void;
  deselect(): void;
  // measure
  lastMeasure(): string;
  measureCount(): number;
  clearMeasures(): void;
  /** Type what a real tape measure says for the last measurement. */
  measureTruth(): void;
  // view
  realWalls(): 'shown' | 'outline' | 'hidden';
  cycleRealWalls(): void;
  roomMeshMode(): 'off' | 'mesh' | 'color';
  cycleRoomMesh(): void;
  labels(): boolean;
  toggleLabels(): void;
  occlusion(): boolean;
  toggleOcclusion(): void;
  snap(): boolean;
  toggleSnap(): void;
  menuMode(): string;
  cycleMenuMode(): void;
  exit(): void;
}

/** A pluggable tab: tiles + chip rows, built from the same parts. */
export interface ExtraTab {
  name: TabName;
  label: string;
  icon: IconName;
  defaultTool?: ToolName;
  tiles: Array<{ id: string; icon: IconName; label: () => string; tool?: ToolName; onClick?: () => void; enabled?: () => boolean }>;
  text?: () => string;
  /** Up to 4 rows of chips; each chip spans 1-4 of 4 columns. */
  rows: Array<Array<ChipDef>>;
}

export interface ChipDef {
  id: string;
  label: () => string;
  onClick: () => void;
  span?: number;
  icon?: IconName;
  tone?: 'normal' | 'danger' | 'primary';
  active?: () => boolean;
  enabled?: () => boolean;
  visible?: () => boolean;
  /** Fixed start column, for chips that swap places with each other. */
  col?: number;
}

// Layout (meters).
export const MENU_W = 0.34;
export const MENU_H = 0.25;
const RAIL_W = 0.046;
const PAD = 0.008;
const CX0 = -MENU_W / 2 + RAIL_W + PAD * 1.5; // content left
const CX1 = MENU_W / 2 - PAD; // content right
const CW = CX1 - CX0;
const TILE_W = 0.062;
const TILE_H = 0.054;
const CHIP_H = 0.025;
const GAP = 0.006;
const COL_W = (CW - 3 * GAP) / 4;

/**
 * The wrist menu: a tab rail on the left (like Quest's own menus and apps such as
 * Gravity Sketch / Open Brush), big icon tiles for tools, context chips for the
 * active tool, and Undo/Redo always at hand.
 */
export class MainMenu {
  readonly panel: SpatialPanel;
  tab: TabName = 'room';
  /** Rows that don't fit on the panel (should stay empty; checked by the tests). */
  overflow: string[] = [];

  constructor(
    world: World,
    private api: MenuApi,
  ) {
    this.panel = new SpatialPanel(world, MENU_W, MENU_H);
    const tabs = this.tabs();
    const top = MENU_H / 2 - PAD;
    const TAB_H = Math.min(0.034, (MENU_H - 2 * PAD) / tabs.length - 0.002);

    // --- Tab rail -------------------------------------------------------------
    tabs.forEach((t, i) => {
      this.panel.add({
        id: `tab-${t.name}`,
        x: -MENU_W / 2 + PAD * 0.75 + RAIL_W / 2,
        y: top - TAB_H / 2 - i * (TAB_H + 0.002),
        w: RAIL_W,
        h: TAB_H,
        render: tabRenderer(t.icon, t.label),
        active: () => this.tab === t.name,
        onClick: () => this.openTab(t.name),
      });
    });

    // --- Header: tool name + hint ------------------------------------------------
    this.panel.add({
      id: 'header',
      x: CX0 + CW / 2 - 0.035,
      y: top - 0.013,
      w: CW - 0.07,
      h: 0.026,
      key: () => this.headerText(),
      render: textRenderer(() => this.headerText(), { titlePx: 30, bodyPx: 22 }),
    });

    // --- Undo / redo (always visible, top right) -------------------------------
    const rb = 0.026;
    this.panel.add({
      id: 'undo',
      x: CX1 - rb * 1.5 - 0.004,
      y: top - rb / 2,
      w: rb,
      h: rb,
      render: roundRenderer('undo'),
      onClick: () => api.undo(),
      enabled: () => api.canUndo(),
    });
    this.panel.add({
      id: 'redo',
      x: CX1 - rb / 2,
      y: top - rb / 2,
      w: rb,
      h: rb,
      render: roundRenderer('redo'),
      onClick: () => api.redo(),
      enabled: () => api.canRedo(),
    });

    const tilesY = top - 0.034 - TILE_H / 2;
    const textY = tilesY - TILE_H / 2 - 0.013;
    const rowY = (r: number) => textY - 0.016 - r * (CHIP_H + GAP);

    for (const t of tabs) {
      const inTab = () => this.tab === t.name;
      t.tiles.forEach((tile, i) => {
        this.panel.add({
          id: tile.tool ? `tool-${tile.tool}` : tile.id,
          x: CX0 + TILE_W / 2 + i * (TILE_W + GAP),
          y: tilesY,
          w: TILE_W,
          h: TILE_H,
          key: tile.label,
          render: tileRenderer(tile.icon, tile.label),
          visible: inTab,
          active: () => !!tile.tool && api.tool() === tile.tool,
          enabled: tile.enabled,
          onClick: () => (tile.tool ? api.setTool(tile.tool) : tile.onClick?.()),
        });
      });
      // Tabs without tiles move their content up.
      const lift = t.tiles.length ? 0 : TILE_H + GAP;
      if (t.text) {
        const text = t.text;
        this.panel.add({
          id: `text-${t.name}`,
          x: CX0 + CW / 2,
          y: textY + lift,
          w: CW,
          h: 0.018,
          key: text,
          render: textRenderer(text, { titlePx: 30 }),
          visible: inTab,
        });
      }
      t.rows.forEach((row, r) => {
        // A row whose chips would hang off the panel is a layout bug: record it.
        if (rowY(r) + lift - CHIP_H / 2 < -MENU_H / 2 + PAD / 2) this.overflow.push(`${t.name} row ${r + 1}`);
        let col = 0;
        for (const chip of row) {
          const span = chip.span ?? 1;
          if (chip.col !== undefined) col = chip.col;
          const w = span * COL_W + (span - 1) * GAP;
          if (CX0 + col * (COL_W + GAP) + w > CX1 + 0.001) this.overflow.push(`${t.name} chip ${chip.id} past the right edge`);
          this.panel.add({
            id: chip.id,
            x: CX0 + col * (COL_W + GAP) + w / 2,
            y: rowY(r) + lift,
            w,
            h: CHIP_H,
            key: chip.label,
            render: chipRenderer(chip.label, { icon: chip.icon, tone: chip.tone }),
            visible: () => inTab() && (chip.visible?.() ?? true),
            active: chip.active,
            enabled: chip.enabled,
            onClick: chip.onClick,
          });
          col += span;
        }
      });
    }
    this.panel.refresh();
  }

  private headerText(): string {
    return this.api.toolHint();
  }

  openTab(name: TabName): void {
    this.tab = name;
    const t = this.tabs().find((x) => x.name === name);
    const toolTabs = t?.tiles.map((x) => x.tool).filter(Boolean) ?? [];
    if (t?.defaultTool && !toolTabs.includes(this.api.tool()) && this.api.tool() !== t.defaultTool) this.api.setTool(t.defaultTool);
    this.panel.refresh();
  }

  /** Keep the open tab in sync when the tool changes from elsewhere (thumbstick). */
  syncTab(tool: ToolName): void {
    const t =
      this.tabs().find((x) => x.tiles.some((tile) => tile.tool === tool)) ??
      this.tabs().find((x) => !x.tiles.length && x.defaultTool === tool);
    if (t && t.name !== this.tab) {
      this.tab = t.name;
      this.panel.refresh();
    }
  }

  private cachedTabs: ExtraTab[] | null = null;

  tabs(): ExtraTab[] {
    if (this.cachedTabs) return this.cachedTabs;
    const a = this.api;
    const sel = (k: 'wall' | 'opening') => () => a.selectionKind() === k;
    const any = () => a.selectionKind() !== null;
    const tabs: ExtraTab[] = [
      {
        name: 'room',
        label: 'Room',
        icon: 'scan',
        tiles: [
          { id: 'import', icon: 'import', label: () => 'Space Setup', onClick: () => a.importSpaceSetup() },
          { id: 'scan', icon: 'scan', label: () => (a.scanning() ? 'Stop scan' : 'Scan'), onClick: () => a.toggleScan() },
          { id: 'align', icon: 'align', label: () => 'Align', tool: 'align' },
        ],
        text: () => a.roomStatus(),
        rows: [
          [{ id: 'check', label: () => 'Check walls against scan', icon: 'scan', span: 4, onClick: () => a.checkWalls(), enabled: () => a.hasRoomMesh() && !a.scanning() }],
          [
            { id: 'scan-clear', label: () => 'Clear scan', tone: 'danger', span: 2, onClick: () => a.clearScan(), enabled: () => a.hasRoomMesh() && !a.scanning() },
            { id: 'start-over', label: () => (a.startOverArmed() ? 'Tap again to erase' : 'Start over'), icon: 'trash', tone: 'danger', span: 2, onClick: () => a.startOver(), enabled: () => !a.scanning() },
          ],
        ],
      },
      {
        name: 'edit',
        label: 'Edit',
        icon: 'edit',
        defaultTool: 'edit',
        tiles: [
          { id: 'edit', icon: 'edit', label: () => 'Select', tool: 'edit' },
          { id: 'trace', icon: 'capture', label: () => 'Real wall', tool: 'trace' },
          { id: 'walls', icon: 'walls', label: () => 'New wall', tool: 'walls' },
          { id: 'doors', icon: 'door', label: () => 'Door', tool: 'doors' },
        ],
        rows: [
          [
            { id: 'finish', label: () => 'Finish', icon: 'flag', span: 2, onClick: () => a.finishChain(), enabled: () => a.drawing(), visible: () => a.tool() === 'walls' },
            { id: 'len', label: () => 'Length', icon: 'keypad', span: 2, col: 2, onClick: () => a.typeLength(), enabled: () => a.hasLastWall(), visible: () => a.tool() === 'walls' },
            ...(
              [
                ['door', 30, '30"'],
                ['door', 32, '32"'],
                ['door', 36, '36"'],
                ['opening', 36, 'Open 36"'],
              ] as const
            ).map(([type, w, label], i) => ({
              id: `preset-${type}-${w}`,
              col: i,
              label: () => label,
              onClick: () => a.setPreset(type, w),
              active: () => !a.measureDoors() && a.preset().type === type && a.preset().width === w,
              visible: () => a.tool() === 'doors',
            })),
            { id: 'e-snap', label: () => 'Snap to scan', icon: 'scan', span: 2, col: 0, onClick: () => a.snapSelected(), enabled: () => a.hasRoomMesh(), visible: sel('wall') },
            { id: 'e-len', label: () => 'Length', icon: 'keypad', col: 2, onClick: () => a.editLength(), visible: sel('wall') },
            { id: 'e-thick', label: () => 'Thick', icon: 'keypad', col: 3, onClick: () => a.editThickness(), visible: sel('wall') },
            { id: 'e-w', label: () => 'Width', icon: 'keypad', col: 0, onClick: () => a.editWidth(), visible: sel('opening') },
            { id: 'e-oh', label: () => 'Height', icon: 'height', col: 1, onClick: () => a.editOpeningHeight(), visible: sel('opening') },
            { id: 'e-type', label: () => a.openingType(), col: 2, onClick: () => a.cycleOpeningType(), visible: sel('opening') },
            { id: 'e-flip', label: () => 'Flip', col: 3, onClick: () => a.flipDoor(), visible: () => a.selectionKind() === 'opening' && a.openingType() === 'Door' },
          ],
          [
            {
              id: 'custom-width',
              label: () => {
                const p = a.preset();
                return [30, 32, 36].includes(p.width) ? 'Custom width' : `Custom ${+p.width.toFixed(2)}"`;
              },
              icon: 'keypad',
              span: 2,
              onClick: () => a.customWidth(),
              active: () => !a.measureDoors() && ![30, 32, 36].includes(a.preset().width),
              visible: () => a.tool() === 'doors',
            },
            { id: 'measure-door', label: () => 'Real door', icon: 'capture', span: 2, col: 2, onClick: () => a.setMeasureDoors(), active: () => a.measureDoors(), visible: () => a.tool() === 'doors' },
            { id: 'e-kind', label: () => (a.selectedIsReal() ? 'Real' : 'Planned'), col: 0, onClick: () => a.toggleKind(), visible: sel('wall') },
            { id: 'e-lock', label: () => (a.selectedLocked() ? 'Unlock' : 'Lock'), col: 1, onClick: () => a.toggleLock(), active: () => a.selectedLocked(), visible: any },
            { id: 'e-del', label: () => 'Delete', icon: 'trash', tone: 'danger', col: 2, onClick: () => a.deleteSelection(), visible: any },
            { id: 'e-none', label: () => 'Deselect', col: 3, onClick: () => a.deselect(), visible: any },
          ],
        ],
      },
      {
        name: 'measure',
        label: 'Measure',
        icon: 'measure',
        defaultTool: 'measure',
        tiles: [{ id: 'measure', icon: 'measure', label: () => 'Tape', tool: 'measure' }],
        text: () => a.lastMeasure() || 'Pinch two spots on the floor or walls',
        rows: [
          [
            { id: 'm-truth', label: () => 'Tape says...', icon: 'keypad', span: 2, onClick: () => a.measureTruth(), enabled: () => a.measureCount() > 0 },
            { id: 'm-clear', label: () => `Clear all (${a.measureCount()})`, icon: 'trash', tone: 'danger', span: 2, onClick: () => a.clearMeasures(), enabled: () => a.measureCount() > 0 },
          ],
        ],
      },
      {
        name: 'view',
        label: 'View',
        icon: 'eye',
        tiles: [],
        rows: [
          [
            {
              id: 'realwalls',
              label: () => `Real walls: ${a.realWalls() === 'shown' ? 'shown' : a.realWalls() === 'outline' ? 'lines' : 'hidden'}`,
              span: 2,
              onClick: () => a.cycleRealWalls(),
              active: () => a.realWalls() !== 'shown',
            },
            {
              id: 'roommesh',
              label: () => `Mesh: ${a.roomMeshMode()}`,
              span: 2,
              onClick: () => a.cycleRoomMesh(),
              active: () => a.roomMeshMode() !== 'off',
            },
          ],
          [
            { id: 'labels', label: () => 'Labels', onClick: () => a.toggleLabels(), active: () => a.labels() },
            { id: 'snap', label: () => 'Snap', icon: 'magnet', onClick: () => a.toggleSnap(), active: () => a.snap() },
            { id: 'occlusion', label: () => 'Occlude', icon: 'eye', span: 2, onClick: () => a.toggleOcclusion(), active: () => a.occlusion() },
          ],
          [
            {
              id: 'pin',
              label: () => `Menu: ${a.menuMode() === 'wrist' ? 'wrist' : a.menuMode() === 'float' ? 'float' : 'pinned'}`,
              icon: 'thumbtack',
              span: 2,
              onClick: () => a.cycleMenuMode(),
              active: () => a.menuMode() !== 'wrist',
            },
            { id: 'exit', label: () => 'Exit AR', icon: 'exit', tone: 'danger', span: 2, onClick: () => a.exit() },
          ],
        ],
      },
    ];
    this.cachedTabs = tabs;
    return tabs;
  }
}

export { THEME };
