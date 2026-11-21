import { createEmptyPlan, parsePlan, type Plan } from './plan.js';

const KEY = 'basement-planner:plan:v1';

/** Minimal storage interface so tests can pass a fake. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): KV | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadSavedPlan(storage: KV | null = defaultStorage()): { plan: Plan; restored: boolean } {
  try {
    const raw = storage?.getItem(KEY);
    if (raw) return { plan: parsePlan(JSON.parse(raw)), restored: true };
  } catch (e) {
    console.warn('[planner] saved plan unreadable, starting fresh', e);
  }
  return { plan: createEmptyPlan(), restored: false };
}

export function savePlan(plan: Plan, storage: KV | null = defaultStorage()): boolean {
  try {
    storage?.setItem(KEY, JSON.stringify(plan));
    return !!storage;
  } catch (e) {
    console.warn('[planner] could not save plan', e);
    return false;
  }
}

export function planToJson(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}

export function planFromJson(text: string): Plan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON.');
  }
  return parsePlan(data);
}
