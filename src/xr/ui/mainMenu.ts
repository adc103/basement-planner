import type { World } from '@iwsdk/core';
import { formatLength } from '../../core/units.js';
import type { IconName } from './icons.js';
import { chipRenderer, roundRenderer, SpatialPanel, tabRenderer, textRenderer, tileRenderer, THEME } from './spatialPanel.js';

export type TabName = 'build' | 'edit' | 'measure' | 'rooms' | 'pins' | 'ceiling' | 'scan' | 'view';
export type ToolName = 'walls' | 'doors' | 'capture' | 'edit' | 'delete' | 'measure' | 'align' | 'rooms' | 'pins' | 'soffit' | 'review' | 'dimension' | 'section' | 'box';

/** Everything the menu needs from the app. */
export interface MenuApi {
  tool(): ToolName;
  setTool(t: ToolName): void;
  toolHint(): string;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  // build
  drawing(): boolean;
  finishChain(): void;
  typeLength(): void;
  hasLastWall(): boolean;
  typeHeight(): void;
  wallHeight(): number;
  preset(): { type: 'door' | 'opening'; width: number };
  setPreset(type: 'door' | 'opening', width: number): void;
  customWidth(): void;
  captureThickness(): number;
  captureProposal(): boolean;
  acceptCapture(): void;
  cancelCapture(): void;
  setCaptureThickness(t: number): void;
  // edit
  selectionText(): string;
  selectionKind(): 'wall' | 'opening' | 'marker' | 'box' | null;
  boxPresets(): string[];
  boxPreset(): string;
  setBoxPreset(label: string): void;
  editBoxHeight(): void;
  selectedBoxKind(): 'box' | 'soffit' | null;
  selectedStud(): '2x4' | '2x6' | null;
  editLength(): void;
  editHeight(): void;
  editStud(s: '2x4' | '2x6'): void;
  editWidth(): void;
  deleteSelection(): void;
  edit(action: 'thickness' | 'split' | 'kind' | 'openingHeight' | 'openingType' | 'flip' | 'lock' | 'demolish' | 'fit' | 'keepLength'): void;
  selectedKeptLength(): boolean;
  dimText(): string;
  dimState(): 'none' | 'one' | 'parallel' | 'angle';
  dimKept(type: 'distance' | 'parallel' | 'perpendicular'): boolean;
  dimMode(): 'clear' | 'center';
  dim(action: 'type' | 'keep' | 'mode' | 'square' | 'parallel' | 'reset'): void;
  checkWalls(): void;
  hasRoomMesh(): boolean;
  selectedLocked(): boolean;
  selectedDemolish(): boolean;
  openingType(): string;
  selectedIsReal(): boolean;
  deselect(): void;
  // measure
  lastMeasure(): string;
  measureCount(): number;
  clearMeasures(): void;
  // scan
  scanStatus(): string;
  importScan(): void;
  /** Depth scan: walk the basement, then review what was found. */
  scanning(): boolean;
  toggleScan(): void;
  scanProposals(): number;
  scanReviewing(): boolean;
  scanKind(k: 'walls' | 'soffits' | 'posts'): { on: boolean; n: number };
  toggleScanKind(k: 'walls' | 'soffits' | 'posts'): void;
  acceptScan(): void;
  discardScan(): void;
  clearScan(): void;
  hasScanMap(): boolean;
  autoImport(): boolean;
  toggleAutoImport(): void;
  hasRefs(): boolean;
  cameraTest(): void;
  cameraTestRunning(): boolean;
  resetRefs(): void;
  // view
  viewMode(): string;
  setViewMode(m: string): void;
  viewModes(): Array<{ id: string; label: string }>;
  viewText(): string;
  realWalls(): 'shown' | 'outline' | 'hidden';
  roomMesh(): boolean;
  hasSection(): boolean;
  dollhouse(): boolean;
  dollAction(a: 'toggle' | 'left' | 'right' | 'bigger' | 'smaller' | 'here'): void;
  cutHeight(): boolean;
  sectionAction(a: 'flip' | 'clear' | 'height'): void;
  toggleRoomMesh(): void;
  cycleRealWalls(): void;
  labels(): boolean;
  toggleLabels(): void;
  occlusion(): boolean;
  toggleOcclusion(): void;
  snap(): boolean;
  toggleSnap(): void;
  pinned(): boolean;
  togglePin(): void;
  menuMode(): string;
  cycleMenuMode(): void;
  exit(): void;
  /** Extra tab content providers (rooms, pins), registered by later features. */
  extraTabs?: ExtraTab[];
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
  tab: TabName = 'build';
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
    const wallsOnly = () => a.tool() === 'walls';
    const doorsOnly = () => a.tool() === 'doors';
    const captureOnly = () => a.tool() === 'capture';
    const sel = (k: 'wall' | 'opening' | 'marker' | 'box') => () => a.selectionKind() === k;
    const boxOnly = () => a.tool() === 'box';
    const tabs: ExtraTab[] = [
      {
        name: 'build',
        label: 'Build',
        icon: 'build',
        defaultTool: 'walls',
        tiles: [
          { id: 'walls', icon: 'walls', label: () => 'Walls', tool: 'walls' },
          { id: 'doors', icon: 'door', label: () => 'Doors', tool: 'doors' },
          { id: 'capture', icon: 'capture', label: () => 'Capture', tool: 'capture' },
          { id: 'box', icon: 'build', label: () => 'Box', tool: 'box' },
        ],
        text: () =>
          a.tool() === 'walls'
            ? `New walls ${formatLength(a.wallHeight())} high`
            : a.tool() === 'doors'
              ? 'Door size'
              : a.tool() === 'capture'
                ? 'Thickness of captured walls'
                : a.tool() === 'box'
                  ? 'Bench, desk, counter or cabinet: drag it out on the floor'
                  : '',
        rows: [
          [
            { id: 'finish', label: () => 'Finish', icon: 'flag', onClick: () => a.finishChain(), enabled: () => a.drawing(), visible: wallsOnly },
            { id: 'len', label: () => 'Length', icon: 'keypad', onClick: () => a.typeLength(), enabled: () => a.hasLastWall(), visible: wallsOnly },
            { id: 'height', label: () => 'Height', icon: 'height', onClick: () => a.typeHeight(), visible: wallsOnly },
            { id: 'snap-b', label: () => (a.snap() ? 'Snap on' : 'Snap off'), icon: 'magnet', onClick: () => a.toggleSnap(), active: () => a.snap(), visible: wallsOnly },
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
              active: () => a.preset().type === type && a.preset().width === w,
              visible: doorsOnly,
            })),
            ...['Bench', 'Desk', 'Counter', 'Tall cabinet'].map((label, i) => ({
              id: `box-${i}`,
              col: i,
              label: () => (label === 'Tall cabinet' ? 'Tall' : label),
              onClick: () => a.setBoxPreset(label),
              active: () => a.boxPreset() === label,
              visible: boxOnly,
            })),
            { id: 'cap-45', label: () => 'Stud 4 1/2"', span: 2, col: 0, onClick: () => a.setCaptureThickness(4.5), active: () => a.captureThickness() === 4.5, visible: captureOnly },
            { id: 'cap-8', label: () => 'Block 8"', span: 2, col: 2, onClick: () => a.setCaptureThickness(8), active: () => a.captureThickness() === 8, visible: captureOnly },
          ],
          [
            {
              id: 'custom-width',
              label: () => {
                const p = a.preset();
                const std = [30, 32, 36].includes(p.width);
                return std ? 'Custom width' : `Custom ${+p.width.toFixed(2)}"`;
              },
              icon: 'keypad',
              span: 2,
              onClick: () => a.customWidth(),
              active: () => ![30, 32, 36].includes(a.preset().width),
              visible: doorsOnly,
            },
          ],
          [
            { id: 'cap-add', label: () => 'Add found wall', icon: 'capture', tone: 'primary', span: 2, onClick: () => a.acceptCapture(), visible: () => captureOnly() && a.captureProposal() },
            { id: 'cap-cancel', label: () => 'Cancel', span: 2, onClick: () => a.cancelCapture(), visible: () => captureOnly() && a.captureProposal() },
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
          { id: 'delete', icon: 'trash', label: () => 'Delete', tool: 'delete' },
          { id: 'dimension', icon: 'dimension', label: () => 'Dimension', tool: 'dimension' },
        ],
        text: () => (a.tool() === 'edit' ? a.selectionText() || 'Nothing selected' : a.tool() === 'dimension' ? a.dimText() : 'Point and pinch to delete'),
        // Four rows fit under the tiles. Dimension chips share rows with the
        // selection chips: the two tools are never active at once.
        rows: [
          [
            { id: 'd-type', label: () => 'Type distance', icon: 'keypad', span: 2, col: 0, onClick: () => a.dim('type'), visible: () => a.tool() === 'dimension' && a.dimState() === 'parallel' },
            { id: 'd-keep', label: () => (a.dimKept('distance') ? 'Unkeep' : 'Keep'), span: 1, col: 2, onClick: () => a.dim('keep'), active: () => a.dimKept('distance'), visible: () => a.tool() === 'dimension' && a.dimState() === 'parallel' },
            { id: 'd-mode', label: () => (a.dimMode() === 'clear' ? 'Clear' : 'Center'), span: 1, col: 3, onClick: () => a.dim('mode'), visible: () => a.tool() === 'dimension' && a.dimState() === 'parallel' },
            { id: 'd-square', label: () => (a.dimKept('perpendicular') ? 'Unsquare' : 'Make square'), span: 2, col: 0, onClick: () => a.dim('square'), active: () => a.dimKept('perpendicular'), visible: () => a.tool() === 'dimension' && a.dimState() === 'angle' },
            { id: 'd-par', label: () => (a.dimKept('parallel') ? 'Unparallel' : 'Make parallel'), span: 2, col: 2, onClick: () => a.dim('parallel'), active: () => a.dimKept('parallel'), visible: () => a.tool() === 'dimension' && a.dimState() === 'angle' },
            { id: 'e-len', label: () => 'Length', icon: 'keypad', col: 0, onClick: () => a.editLength(), visible: sel('wall') },
            { id: 'e-h', label: () => 'Height', icon: 'height', col: 1, onClick: () => a.editHeight(), visible: sel('wall') },
            { id: 'e-2x4', label: () => '2x4', col: 2, onClick: () => a.editStud('2x4'), active: () => a.selectedStud() === '2x4', visible: sel('wall') },
            { id: 'e-2x6', label: () => '2x6', col: 3, onClick: () => a.editStud('2x6'), active: () => a.selectedStud() === '2x6', visible: sel('wall') },
            { id: 'e-w', label: () => 'Width', icon: 'keypad', col: 0, onClick: () => a.editWidth(), visible: sel('opening') },
            { id: 'e-bh', label: () => (a.selectedBoxKind() === 'soffit' ? 'Bottom' : 'Height'), icon: 'height', span: 2, col: 0, onClick: () => a.editBoxHeight(), visible: sel('box') },
            { id: 'e-oh', label: () => 'Height', icon: 'height', col: 1, onClick: () => a.edit('openingHeight'), visible: sel('opening') },
            { id: 'e-type', label: () => a.openingType(), col: 2, onClick: () => a.edit('openingType'), visible: sel('opening') },
            { id: 'e-flip', label: () => 'Flip', col: 3, onClick: () => a.edit('flip'), visible: () => a.selectionKind() === 'opening' && a.openingType() === 'Door' },
          ],
          [
            { id: 'd-again', label: () => 'Pick again', span: 4, col: 0, onClick: () => a.dim('reset'), visible: () => a.tool() === 'dimension' && a.dimState() !== 'none' },
            { id: 'e-thick', label: () => 'Thickness', icon: 'keypad', col: 0, onClick: () => a.edit('thickness'), visible: sel('wall') },
            { id: 'e-split', label: () => 'Split', col: 1, onClick: () => a.edit('split'), visible: sel('wall') },
            { id: 'e-kind', label: () => (a.selectedIsReal() ? 'Make planned' : 'Make real'), span: 2, col: 2, onClick: () => a.edit('kind'), visible: sel('wall') },
          ],
          [
            { id: 'e-keeplen', label: () => (a.selectedKeptLength() ? 'Unkeep length' : 'Keep length'), span: 2, col: 0, onClick: () => a.edit('keepLength'), active: () => a.selectedKeptLength(), visible: sel('wall') },
            { id: 'e-fit', label: () => 'Fit to scan', icon: 'scan', span: 2, col: 2, onClick: () => a.edit('fit'), enabled: () => a.hasRoomMesh(), visible: () => a.selectionKind() === 'wall' && a.selectedIsReal() },
          ],
          [
            {
              id: 'e-demo',
              label: () => (a.selectedDemolish() ? 'Keep' : 'Demolish'),
              col: 0,
              tone: 'danger',
              onClick: () => a.edit('demolish'),
              active: () => a.selectedDemolish(),
              visible: () => a.selectionKind() === 'wall' && a.selectedIsReal(),
            },
            { id: 'e-lock', label: () => (a.selectedLocked() ? 'Unlock' : 'Lock'), col: 1, onClick: () => a.edit('lock'), active: () => a.selectedLocked(), visible: () => a.selectionKind() !== null },
            { id: 'e-del', label: () => 'Delete', icon: 'trash', tone: 'danger', col: 2, onClick: () => a.deleteSelection(), visible: () => a.selectionKind() !== null },
            { id: 'e-none', label: () => 'Deselect', col: 3, onClick: () => a.deselect(), visible: () => a.selectionKind() !== null },
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
            {
              id: 'm-clear',
              label: () => `Clear all (${a.measureCount()})`,
              icon: 'trash',
              tone: 'danger',
              span: 2,
              onClick: () => a.clearMeasures(),
              enabled: () => a.measureCount() > 0,
            },
          ],
        ],
      },
      ...(a.extraTabs ?? []),
      {
        name: 'scan',
        label: 'Room',
        icon: 'scan',
        tiles: [
          { id: 'scan-depth', icon: 'scan', label: () => (a.scanning() ? 'Stop' : 'Scan'), onClick: () => a.toggleScan() },
          { id: 'scan-now', icon: 'import', label: () => 'Space Setup', onClick: () => a.importScan() },
          { id: 'align', icon: 'align', label: () => 'Align', tool: 'align' },
        ],
        text: () => a.scanStatus(),
        rows: [
          [
            { id: 'scan-accept', label: () => `Add ${a.scanProposals()} found`, tone: 'primary', span: 2, onClick: () => a.acceptScan(), visible: () => a.scanReviewing() },
            { id: 'scan-discard', label: () => 'Discard', span: 2, onClick: () => a.discardScan(), visible: () => a.scanReviewing() },
            { id: 'auto', label: () => (a.autoImport() ? 'Auto-import on' : 'Auto-import off'), span: 2, col: 0, onClick: () => a.toggleAutoImport(), active: () => a.autoImport(), visible: () => !a.scanReviewing() },
            { id: 'refreset', label: () => 'Reset refs', span: 2, onClick: () => a.resetRefs(), enabled: () => a.hasRefs(), visible: () => !a.scanReviewing() },
          ],
          [
            ...(['walls', 'soffits', 'posts'] as const).map((k, i) => ({
              id: `scan-kind-${k}`,
              col: i,
              label: () => `${k === 'walls' ? 'Walls' : k === 'soffits' ? 'Low' : 'Posts'} ${a.scanKind(k).n}`,
              onClick: () => a.toggleScanKind(k),
              active: () => a.scanKind(k).on,
              visible: () => a.scanReviewing(),
            })),
            { id: 'scan-clear', col: 0, label: () => 'Clear scan', icon: 'trash', tone: 'danger', span: 2, onClick: () => a.clearScan(), enabled: () => a.hasScanMap() && !a.scanning(), visible: () => !a.scanReviewing() },
            {
              id: 'camtest',
              label: () => (a.cameraTestRunning() ? 'Testing camera...' : 'Camera test'),
              icon: 'eye',
              span: 2,
              onClick: () => a.cameraTest(),
              enabled: () => !a.cameraTestRunning(),
              visible: () => !a.scanReviewing(),
            },
          ],
          [
            { id: 'scan-check', label: () => 'Check walls against scan', icon: 'scan', span: 4, col: 0, onClick: () => a.checkWalls(), enabled: () => a.hasRoomMesh() && !a.scanning(), visible: () => !a.scanReviewing() },
          ],
        ],
      },
      {
        name: 'view',
        label: 'View',
        icon: 'eye',
        tiles: [],
        text: () => a.viewText(),
        rows: [
          [
            ...a.viewModes().map((m) => ({ id: `mode-${m.id}`, label: () => m.label, onClick: () => a.setViewMode(m.id), active: () => a.viewMode() === m.id })),
            {
              id: 'realwalls',
              label: () => `Real: ${a.realWalls() === 'shown' ? 'shown' : a.realWalls() === 'outline' ? 'lines' : 'hidden'}`,
              onClick: () => a.cycleRealWalls(),
              active: () => a.realWalls() !== 'shown',
            },
          ],
          [
            { id: 'labels', label: () => 'Labels', span: 1, onClick: () => a.toggleLabels(), active: () => a.labels() },
            { id: 'snap', label: () => 'Snap', icon: 'magnet', span: 1, onClick: () => a.toggleSnap(), active: () => a.snap() },
            { id: 'occlusion', label: () => 'Occlude', icon: 'eye', span: 1, onClick: () => a.toggleOcclusion(), active: () => a.occlusion() },
            { id: 'roommesh', label: () => 'Mesh', span: 1, onClick: () => a.toggleRoomMesh(), active: () => a.roomMesh() },
          ],
          [
            { id: 'section', label: () => 'Section', span: 1, col: 0, onClick: () => a.setTool(a.tool() === 'section' ? 'walls' : 'section'), active: () => a.tool() === 'section' },
            { id: 'sec-flip', label: () => 'Flip', span: 1, col: 1, onClick: () => a.sectionAction('flip'), enabled: () => a.hasSection() },
            { id: 'sec-clear', label: () => 'Clear', span: 1, col: 2, onClick: () => a.sectionAction('clear'), enabled: () => a.hasSection() },
            { id: 'sec-cut', label: () => 'Cut 4 ft', span: 1, col: 3, onClick: () => a.sectionAction('height'), active: () => a.cutHeight() },
          ],
          [
            { id: 'doll', label: () => 'Dollhouse', span: 2, col: 0, onClick: () => a.dollAction('toggle'), active: () => a.dollhouse() },
            { id: 'doll-l', label: () => 'Turn L', span: 1, col: 2, onClick: () => a.dollAction('left'), visible: () => a.dollhouse() },
            { id: 'doll-r', label: () => 'Turn R', span: 1, col: 3, onClick: () => a.dollAction('right'), visible: () => a.dollhouse() },
          ],
          [
            { id: 'doll-s', label: () => 'Smaller', span: 1, col: 0, onClick: () => a.dollAction('smaller'), visible: () => a.dollhouse() },
            { id: 'doll-b', label: () => 'Bigger', span: 1, col: 1, onClick: () => a.dollAction('bigger'), visible: () => a.dollhouse() },
            { id: 'doll-h', label: () => 'Bring here', span: 2, col: 2, onClick: () => a.dollAction('here'), visible: () => a.dollhouse() },
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
