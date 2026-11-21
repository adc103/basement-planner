import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PokeInteractable,
  RayInteractable,
  SRGBColorSpace,
  type Entity,
  type World,
} from '@iwsdk/core';
import { roundRect } from './labels.js';

export interface ButtonSpec {
  id: string;
  label: string | (() => string);
  /** Width in grid columns (default 1). */
  span?: number;
  onClick: () => void;
  /** Highlighted (e.g. active tool). */
  active?: () => boolean;
  enabled?: () => boolean;
  /** Visual accent. */
  tone?: 'normal' | 'primary' | 'danger';
}

export interface PanelSpec {
  title?: string;
  columns: number;
  rows: ButtonSpec[][];
  /** Button height in meters. */
  buttonHeight?: number;
  /** Column width in meters. */
  columnWidth?: number;
  gap?: number;
}

interface ButtonState {
  spec: ButtonSpec;
  mesh: Mesh;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  hovered: boolean;
  lastKey: string;
  cooldownUntil: number;
  pxW: number;
  pxH: number;
}

const PX_PER_M = 1600;

/**
 * A flat panel of buttons. Buttons are separate entities with RayInteractable
 * and PokeInteractable, so IWSDK's pointers (controller rays, hand rays and
 * fingertip pokes) all dispatch click events to them.
 */
export class ButtonPanel {
  readonly root = new Group();
  readonly entity: Entity;
  /** Background plane; also used for "is the ray on the UI" tests. */
  readonly backing: Mesh;
  private buttons: ButtonState[] = [];
  private titleState?: { canvas: HTMLCanvasElement; texture: CanvasTexture; mesh: Mesh; text: string };
  readonly width: number;
  readonly height: number;

  constructor(
    private world: World,
    spec: PanelSpec,
    parent?: Entity,
  ) {
    const bh = spec.buttonHeight ?? 0.034;
    const cw = spec.columnWidth ?? 0.06;
    const gap = spec.gap ?? 0.006;
    const titleH = spec.title !== undefined ? bh * 0.8 : 0;
    this.width = spec.columns * cw + (spec.columns + 1) * gap;
    this.height = spec.rows.length * bh + (spec.rows.length + 1) * gap + (titleH ? titleH + gap : 0);
    this.entity = world.createTransformEntity(this.root, { parent: parent ?? world.sceneEntity, persistent: true });

    this.backing = new Mesh(
      new PlaneGeometry(this.width, this.height),
      new MeshBasicMaterial({ color: 0x141820, transparent: true, opacity: 0.88, depthWrite: false }),
    );
    this.backing.renderOrder = 10;
    this.root.add(this.backing);

    let y = this.height / 2 - gap;
    if (spec.title !== undefined) {
      const canvas = document.createElement('canvas');
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      const mesh = new Mesh(
        new PlaneGeometry(this.width - 2 * gap, titleH),
        new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
      );
      mesh.position.set(0, y - titleH / 2, 0.001);
      mesh.renderOrder = 11;
      this.root.add(mesh);
      this.titleState = { canvas, texture, mesh, text: '' };
      this.setTitle(spec.title);
      y -= titleH + gap;
    }

    for (const row of spec.rows) {
      let col = 0;
      for (const b of row) {
        const span = b.span ?? 1;
        const w = span * cw + (span - 1) * gap;
        const x = -this.width / 2 + gap + col * (cw + gap) + w / 2;
        this.addButton(b, x, y - bh / 2, w, bh);
        col += span;
      }
      y -= bh + gap;
    }
    this.refresh();
  }

  private addButton(spec: ButtonSpec, x: number, y: number, w: number, h: number): void {
    const canvas = document.createElement('canvas');
    const pxW = Math.round(w * PX_PER_M);
    const pxH = Math.round(h * PX_PER_M);
    canvas.width = pxW;
    canvas.height = pxH;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    mesh.position.set(x, y, 0.002);
    mesh.renderOrder = 12;
    mesh.name = `btn:${spec.id}`;
    this.root.add(mesh);
    const ent = this.world.createTransformEntity(mesh, { parent: this.entity, persistent: true });
    ent.addComponent(RayInteractable);
    ent.addComponent(PokeInteractable);
    const state: ButtonState = { spec, mesh, canvas, texture, hovered: false, lastKey: '', cooldownUntil: 0, pxW, pxH };
    mesh.addEventListener('pointerenter', () => {
      state.hovered = true;
      this.draw(state);
    });
    mesh.addEventListener('pointerleave', () => {
      state.hovered = false;
      this.draw(state);
    });
    mesh.addEventListener('click', () => {
      if (!this.root.visible) return;
      if (spec.enabled && !spec.enabled()) return;
      // A fingertip poke and a ray can both report the same press; debounce per button.
      const now = performance.now();
      if (now < state.cooldownUntil) return;
      state.cooldownUntil = now + 150;
      spec.onClick();
      this.refresh();
    });
    this.buttons.push(state);
  }

  setTitle(text: string): void {
    const t = this.titleState;
    if (!t || t.text === text) return;
    t.text = text;
    const geo = t.mesh.geometry as PlaneGeometry;
    const w = Math.round(geo.parameters.width * PX_PER_M);
    const h = Math.round(geo.parameters.height * PX_PER_M);
    t.canvas.width = w;
    t.canvas.height = h;
    const ctx = t.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#cfd8e3';
    ctx.font = `600 ${Math.round(h * 0.5)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    fitText(ctx, text, w * 0.96, Math.round(h * 0.5));
    ctx.fillText(text, w / 2, h / 2);
    t.texture.needsUpdate = true;
  }

  /** Redraw every button whose label/state changed. */
  refresh(): void {
    for (const b of this.buttons) this.draw(b);
  }

  private draw(b: ButtonState): void {
    const label = typeof b.spec.label === 'function' ? b.spec.label() : b.spec.label;
    const active = b.spec.active?.() ?? false;
    const enabled = b.spec.enabled?.() ?? true;
    const key = `${label}|${active}|${enabled}|${b.hovered}`;
    if (key === b.lastKey) return;
    b.lastKey = key;
    const { pxW: w, pxH: h } = b;
    const ctx = b.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    let bg = '#2a3240';
    if (b.spec.tone === 'primary') bg = '#1f5fa8';
    if (b.spec.tone === 'danger') bg = '#7a2b2b';
    if (active) bg = '#2f86e6';
    if (!enabled) bg = '#22262d';
    if (b.hovered && enabled) bg = lighten(bg);
    ctx.fillStyle = bg;
    roundRect(ctx, 2, 2, w - 4, h - 4, h * 0.22);
    ctx.fill();
    ctx.fillStyle = enabled ? '#ffffff' : '#6b7480';
    const fontPx = Math.round(h * 0.42);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    fitText(ctx, label, w * 0.9, fontPx);
    ctx.fillText(label, w / 2, h / 2 + 1);
    b.texture.needsUpdate = true;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  setVisible(v: boolean): void {
    if (this.root.visible === v) return;
    this.root.visible = v;
    // Hidden buttons must not catch pointers.
    for (const b of this.buttons) b.mesh.pointerEvents = v ? 'auto' : 'none';
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, fontPx: number): void {
  let px = fontPx;
  ctx.font = `600 ${px}px system-ui, sans-serif`;
  while (px > 8 && ctx.measureText(text).width > maxW) {
    px -= 2;
    ctx.font = `600 ${px}px system-ui, sans-serif`;
  }
}

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) + 28);
  const g = Math.min(255, ((n >> 8) & 255) + 28);
  const b = Math.min(255, (n & 255) + 28);
  return `rgb(${r},${g},${b})`;
}
