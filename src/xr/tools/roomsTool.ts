import type { Finish, Plan } from '../../core/plan.js';
import { pointInPolygon } from '../../core/poly.js';
import { faceAt, findRoomFaces, type RoomFace } from '../../core/rooms.js';
import { FINISH_NAMES } from '../../core/plan2d.js';
import type { AimHit, Tool, ToolContext } from './tool.js';

/** Tap inside a closed area to name it and pick its floor finish. */
export class RoomsTool implements Tool {
  readonly name = 'Rooms';
  selectedId: string | null = null;
  private facesFor: Plan | null = null;
  private faces: RoomFace[] = [];
  private hoverKey: string | null = null;

  constructor(private ctx: ToolContext) {}

  activate(): void {}
  deactivate(): void {
    this.ctx.preview.clear();
    this.ctx.view.setSelectedRoom(null);
    this.hoverKey = null;
  }

  private currentFaces(): RoomFace[] {
    const plan = this.ctx.store.plan;
    if (this.facesFor !== plan) {
      this.faces = findRoomFaces(plan);
      this.facesFor = plan;
    }
    return this.faces;
  }

  roomForFace(face: RoomFace) {
    return this.ctx.store.plan.rooms.find((r) => pointInPolygon(r.seed, face.outline));
  }

  selectedFace(): RoomFace | undefined {
    const r = this.selectedRoom();
    return r ? faceAt(this.currentFaces(), r.seed) : undefined;
  }

  selectedRoom() {
    return this.ctx.store.plan.rooms.find((r) => r.id === this.selectedId);
  }

  hint(): string {
    return this.selectedRoom() ? 'Pick a name and floor below' : 'Tap inside a closed area to make it a room';
  }

  describe(): string {
    const r = this.selectedRoom();
    const face = this.selectedFace();
    if (!r) return this.currentFaces().length ? 'No room selected' : 'Close the walls around a space first';
    return `${r.name}: ${face ? `${face.areaSqFt.toFixed(0)} sq ft` : 'walls open'}, ${FINISH_NAMES[r.finish]}`;
  }

  hover(aim: AimHit | null): void {
    const pv = this.ctx.preview;
    pv.clear();
    const face = aim?.floor ? faceAt(this.currentFaces(), aim.floor) : undefined;
    const key = face?.key ?? null;
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      pv.showFloorPoly(face ? face.inner : null);
    } else if (face) {
      pv.showFloorPoly(face.inner, true);
    }
    if (face && aim?.floor) {
      const r = this.roomForFace(face);
      pv.showHint(r ? `${r.name}: ${face.areaSqFt.toFixed(0)} sq ft` : `${face.areaSqFt.toFixed(0)} sq ft: tap to name`, aim.floor, 12);
    }
  }

  commit(aim: AimHit): void {
    if (!aim.floor) return;
    const face = faceAt(this.currentFaces(), aim.floor);
    if (!face) {
      this.ctx.toast('Close the walls around a space to make a room');
      this.select(null);
      return;
    }
    const existing = this.roomForFace(face);
    const id = existing?.id ?? this.ctx.act('room.add', { seed: face.center, name: 'Room' });
    this.select(id);
  }

  select(id: string | null): void {
    this.selectedId = id;
    const face = this.selectedFace();
    this.ctx.view.setSelectedRoom(face?.key ?? null);
    this.ctx.refreshUi();
  }

  validate(): void {
    if (this.selectedId && !this.selectedRoom()) this.select(null);
    else if (this.selectedId) this.ctx.view.setSelectedRoom(this.selectedFace()?.key ?? null);
  }

  setName(name: string): void {
    const r = this.selectedRoom();
    if (r) this.ctx.act('room.update', { id: r.id, name });
  }

  setFinish(finish: Finish): void {
    const r = this.selectedRoom();
    if (r) this.ctx.act('room.update', { id: r.id, finish });
  }

  remove(): void {
    const r = this.selectedRoom();
    if (!r) return;
    this.ctx.act('element.delete', { id: r.id });
    this.select(null);
  }
}
