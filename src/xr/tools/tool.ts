import type { Vec2 } from '../../core/geom2d.js';
import type { SnapOptions } from '../../core/snapping.js';
import type { PlanStore } from '../../core/store.js';
import type { PlanView } from '../planView.js';
import type { Preview } from '../preview.js';

export interface AimHit {
  /** Aim point on the floor (plan inches), or null if the ray misses the floor. */
  floor: Vec2 | null;
  /** Distance from the hand to the floor point, meters (for snap radius). */
  floorDistM: number;
  /** Closest planned/scanned wall hit by the ray. z = height of the hit, inches. */
  wall: { wallId: string; point: Vec2; z: number; distM: number } | null;
  /** Utility marker under the ray. */
  marker: { id: string; distM: number } | null;
  /**
   * Real-world surface under the ray (headset hit test). n = horizontal part of the
   * surface normal in plan space, ny = its vertical part.
   */
  surface: { p: Vec2; z: number; n: Vec2; ny: number; distM: number } | null;
  /** Where the ray meets the ceiling plane (default wall height). */
  ceiling: Vec2 | null;
  /** Fine mode: holding the press. */
  fine: boolean;
  pressing: boolean;
  /** Eye position in plan space (for hints). */
  eye: Vec2;
}

export interface ToolContext {
  store: PlanStore;
  view: PlanView;
  preview: Preview;
  toast(msg: string, seconds?: number): void;
  snapOptions(aim: AimHit, from?: Vec2): SnapOptions;
  /** Report the corner/midpoint under the cursor (or null) for inference guides. */
  acquire(p: Vec2 | null): void;
  openKeypad(title: string, initial: number | null, onOk: (inches: number) => void): void;
  /** Current door/opening preset. */
  openingPreset(): { type: 'door' | 'opening'; width: number; height: number };
  /** Called when something the menu shows may have changed. */
  refreshUi(): void;
}

export interface Tool {
  readonly name: string;
  activate(): void;
  deactivate(): void;
  /** Every frame with the active hand's aim (null when no hand is aiming). */
  hover(aim: AimHit | null): void;
  /** Press began (not on UI). */
  pressStart?(aim: AimHit): void;
  /** Every frame while pressed. */
  drag?(aim: AimHit): void;
  /** Press released: commit at the aim. */
  commit(aim: AimHit): void;
  /** 'drag' tools follow the live ray while pressed (no pinch-lock, no fine mode). */
  inputMode?(): 'place' | 'drag';
  /** Undo key: return true if handled by the tool. */
  undo?(): boolean;
  /** Short instruction for the menu header. */
  hint(): string;
}
