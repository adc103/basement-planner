import { OneEuroFilter } from '1eurofilter';
import { InputComponent, Quaternion, Vector3, type World } from '@iwsdk/core';

export type Side = 'left' | 'right';

/**
 * Per-hand aim + select state, the same for controllers and tracked hands.
 *
 * - The ray comes from the input source's target-ray space (IWSDK raySpaces).
 * - For hands the ray is smoothed with a One-Euro filter.
 * - "Pinch-lock": the aim used for a press is taken from ~90 ms before the
 *   pinch started, before the pinch motion dragged the ray.
 * - "Fine mode": holding the press for 0.5 s without moving switches to 1/4
 *   speed around the locked point. The point is committed on release.
 */
export interface AimSample {
  t: number;
  origin: Vector3;
  dir: Vector3;
}

export type PressPhase = 'idle' | 'pressing' | 'fine';

const FINE_DELAY_S = 0.5;
const FINE_GAIN = 0.25;
const LOCK_LOOKBACK_S = 0.09;
const HISTORY_S = 0.3;

export class HandAim {
  readonly side: Side;
  tracked = false;
  isHand = false;
  /** Filtered ray (world space). */
  readonly origin = new Vector3();
  readonly dir = new Vector3(0, 0, -1);
  /** Effective ray used by tools (locked / fine-adjusted while pressing). */
  readonly aimOrigin = new Vector3();
  readonly aimDir = new Vector3(0, 0, -1);

  phase: PressPhase = 'idle';
  selectStarted = false;
  selectEnded = false;
  /** True when this frame's press began while pointing at UI. */
  pressOnUI = false;

  private filters: OneEuroFilter[] = [];
  private history: AimSample[] = [];
  private pressT = 0;
  private lockOrigin = new Vector3();
  private lockDir = new Vector3();
  private fineRefDir = new Vector3();
  private wasActive = false;
  private tmpQ = new Quaternion();
  private tmpV = new Vector3();

  constructor(side: Side) {
    this.side = side;
    // 6 filters: origin xyz + direction xyz. Tuned for ~72-90 Hz hand tracking.
    for (let i = 0; i < 6; i++) this.filters.push(new OneEuroFilter(72, i < 3 ? 1.0 : 0.8, i < 3 ? 0.4 : 0.3, 1.0));
  }

  update(world: World, time: number): void {
    const xr = world.input.xr;
    const source = xr.getPrimaryInputSource(this.side);
    const space = world.player.raySpaces[this.side];
    this.tracked = !!source && !!world.session;
    this.isHand = !!source?.hand;
    this.selectStarted = false;
    this.selectEnded = false;
    if (!this.tracked) {
      if (this.phase !== 'idle') this.phase = 'idle';
      this.wasActive = false;
      return;
    }

    space.getWorldPosition(this.tmpV);
    space.getWorldQuaternion(this.tmpQ);
    const rawO = this.tmpV;
    const rawD = new Vector3(0, 0, -1).applyQuaternion(this.tmpQ);
    if (this.isHand) {
      const vals = [rawO.x, rawO.y, rawO.z, rawD.x, rawD.y, rawD.z].map((v, i) => this.filters[i].filter(v, time));
      this.origin.set(vals[0], vals[1], vals[2]);
      this.dir.set(vals[3], vals[4], vals[5]).normalize();
    } else {
      this.origin.copy(rawO);
      this.dir.copy(rawD);
    }

    this.history.push({ t: time, origin: this.origin.clone(), dir: this.dir.clone() });
    while (this.history.length && this.history[0].t < time - HISTORY_S) this.history.shift();

    // Select edges: hand pinch (session select events) or controller trigger.
    const st = xr.getSelectState(this.side);
    const pad = xr.gamepads[this.side];
    const active = st.active || !!pad?.getButtonPressed(InputComponent.Trigger);
    if (active && !this.wasActive) {
      this.selectStarted = true;
      this.pressT = time;
      const past = this.isHand ? this.sampleAt(time - LOCK_LOOKBACK_S) : null;
      this.lockOrigin.copy(past?.origin ?? this.origin);
      this.lockDir.copy(past?.dir ?? this.dir);
      this.phase = 'pressing';
    } else if (!active && this.wasActive) {
      this.selectEnded = true;
    }
    this.wasActive = active;

    if (this.phase === 'pressing' && time - this.pressT > FINE_DELAY_S) {
      this.phase = 'fine';
      this.fineRefDir.copy(this.dir);
    }

    if (this.phase === 'pressing') {
      this.aimOrigin.copy(this.lockOrigin);
      this.aimDir.copy(this.lockDir);
    } else if (this.phase === 'fine') {
      // Scale the angular change since fine mode began.
      const delta = this.tmpV.copy(this.dir).sub(this.fineRefDir).multiplyScalar(FINE_GAIN);
      this.aimOrigin.copy(this.lockOrigin);
      this.aimDir.copy(this.lockDir).add(delta).normalize();
    } else {
      this.aimOrigin.copy(this.origin);
      this.aimDir.copy(this.dir);
    }
  }

  /** Call after handling selectEnded. */
  finishPress(): void {
    this.phase = 'idle';
    this.pressOnUI = false;
  }

  private sampleAt(t: number): AimSample | null {
    let best: AimSample | null = null;
    for (const s of this.history) {
      if (s.t <= t) best = s;
      else break;
    }
    return best ?? this.history[0] ?? null;
  }

  // --- Buttons (controllers only) -------------------------------------------
  buttonDown(c: InputComponent, world: World): boolean {
    return !!world.input.xr.gamepads[this.side]?.getButtonDown(c);
  }
  thumbY(world: World): number {
    return world.input.xr.gamepads[this.side]?.getAxesValues(InputComponent.Thumbstick)?.y ?? 0;
  }
}
