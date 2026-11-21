import { createSystem, XRMesh, XRPlane } from '@iwsdk/core';
import { PlannerApp } from './xr/app.js';

let instance: PlannerApp | null = null;
const waiters: Array<(app: PlannerApp) => void> = [];

/** Resolves once the planner has been created inside the ECS world. */
export function whenPlannerReady(): Promise<PlannerApp> {
  return new Promise((resolve) => (instance ? resolve(instance) : waiters.push(resolve)));
}

/** Drives the planner once per frame and gives it the detected room planes. */
export class PlannerSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private app!: PlannerApp;

  init(): void {
    this.app = new PlannerApp(this.world);
    this.app.planeQuery = () => this.queries.planes.entities;
    this.app.meshQuery = () => this.queries.meshes.entities;
    // Re-read the room scan whenever the headset reports new or removed planes/objects.
    const onScan = () => this.app.scheduleAutoImport();
    for (const q of [this.queries.planes, this.queries.meshes]) {
      this.cleanupFuncs.push(q.subscribe('qualify', onScan));
      this.cleanupFuncs.push(q.subscribe('disqualify', onScan));
    }
    this.app.init();
    instance = this.app;
    // Handy for debugging from the browser console (and used by the e2e smoke test).
    (window as unknown as { basementPlanner: PlannerApp }).basementPlanner = this.app;
    for (const w of waiters.splice(0)) w(this.app);
    const onHide = () => this.app.saveNow();
    window.addEventListener('pagehide', onHide);
    this.cleanupFuncs.push(() => window.removeEventListener('pagehide', onHide));
    const session = this.world.visibilityState.subscribe(() => this.app.saveNow());
    this.cleanupFuncs.push(session);
  }

  update(delta: number, time: number): void {
    this.app.update(delta, time);
  }
}
