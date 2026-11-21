import type { Vec2 } from '../../core/geom2d.js';
import type { SnapOptions } from '../../core/snapping.js';
import type { PlanStore } from '../../core/store.js';
import type { PlanView } from '../planView.js';
import type { Preview } from '../preview.js';

export interface AimHit {
  /** Raw aim point on the floor (plan inches), or null if the ray misses the floor. */
  floor: Vec2 | null;
  /** Distance from the hand to the floor point, meters (for snap radius). */
  floorDistM: number;
  /** Closest wall mesh hit by the ray, if any. */
  wall: { wallId: string; point: Vec2; distM: number } | null;
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
  /** Press released: commit at the aim. */
  commit(aim: AimHit): void;
  /** Undo key: return true if handled by the tool. */
  undo?(): boolean;
  /** Short instruction for the menu title. */
  hint(): string;
}
