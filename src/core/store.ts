import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import type { Plan } from './plan.js';

enablePatches();

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
}

export type Listener = (plan: Plan, reason: 'edit' | 'undo' | 'redo' | 'load') => void;

/**
 * Plan store with undo/redo built on Immer patches.
 * Every edit goes through `edit()`; consecutive edits can be grouped with
 * `begin()/end()` so a drag becomes a single undo step.
 */
export class PlanStore {
  private _plan: Plan;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<Listener>();
  private group: HistoryEntry | null = null;
  readonly maxHistory = 200;

  constructor(plan: Plan) {
    this._plan = plan;
  }

  get plan(): Plan {
    return this._plan;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(reason: Parameters<Listener>[1]): void {
    for (const l of this.listeners) l(this._plan, reason);
  }

  /** Apply a mutation. Returns the recipe's return value. */
  edit<T>(label: string, recipe: (draft: Draft<Plan>) => T): T {
    let out: T = undefined as T;
    const [next, patches, inverse] = produceWithPatches(this._plan, (d) => {
      out = recipe(d);
      d.updatedAt = new Date().toISOString();
    });
    // Ignore edits whose only change is the timestamp.
    if (!patches.some((p) => !(p.path.length === 1 && p.path[0] === 'updatedAt'))) return out;
    this._plan = next;
    if (this.group) {
      this.group.patches.push(...patches);
      this.group.inverse.unshift(...inverse);
    } else {
      this.pushHistory({ label, patches, inverse });
    }
    this.emit('edit');
    return out;
  }

  /** Start grouping edits into one undo step. */
  begin(label: string): void {
    if (this.group) this.end();
    this.group = { label, patches: [], inverse: [] };
  }

  end(): void {
    const g = this.group;
    this.group = null;
    if (g && g.patches.length) this.pushHistory(g);
  }

  private pushHistory(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): string | null {
    if (this.group) this.end();
    const e = this.undoStack.pop();
    if (!e) return null;
    this._plan = applyPatches(this._plan, e.inverse);
    this.redoStack.push(e);
    this.emit('undo');
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this._plan = applyPatches(this._plan, e.patches);
    this.undoStack.push(e);
    this.emit('redo');
    return e.label;
  }

  /** Replace the whole plan (load/import/new). Clears history. */
  load(plan: Plan): void {
    this._plan = plan;
    this.undoStack = [];
    this.redoStack = [];
    this.group = null;
    this.emit('load');
  }
}
