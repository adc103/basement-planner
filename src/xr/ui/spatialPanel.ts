import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RayInteractable,
  SRGBColorSpace,
  type Entity,
  type World,
} from '@iwsdk/core';
import { registerPokeButton } from './poke.js';
import { roundRect } from '../labels.js';
import { drawIcon, type IconName } from './icons.js';

/** Look shared by every panel (dark glass, blue accent, like Quest system UI). */
export const THEME = {
  bg: 'rgba(18,22,30,0.94)',
  border: 'rgba(255,255,255,0.10)',
  surface: '#232a36',
  surfaceHover: '#2e3748',
  accent: '#3d8bff',
  accentHover: '#5b9dff',
  danger: '#d9534f',
  text: '#eef3fa',
  textDim: '#93a1b5',
  disabled: '#5d6878',
  font: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};

/** Canvas pixels per meter of panel: high enough to stay crisp at arm's length. */
const PX_PER_M = 3200;

export interface ElState {
  hover: boolean;
  pressed: boolean;
  active: boolean;
  enabled: boolean;
}

export interface ElementSpec {
  id: string;
  /** Center in panel coordinates, meters (origin at panel center, +y up). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Draw into a canvas of W x H pixels. */
  render: (ctx: CanvasRenderingContext2D, W: number, H: number, st: ElState) => void;
  /** Redraw only when this string changes. */
  key?: () => string;
  onClick?: () => void;
  active?: () => boolean;
  enabled?: () => boolean;
  visible?: () => boolean;
}

interface Element {
  spec: ElementSpec;
  mesh: Mesh;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  W: number;
  H: number;
  hover: boolean;
  pressed: boolean;
  lastKey: string;
  cooldownUntil: number;
  shown: boolean;
}

export type Feedback = (kind: 'hover' | 'click') => void;

/**
 * A world-space panel built from canvas-textured quads. Interactive elements are
 * entities with RayInteractable + PokeInteractable, so controller rays, hand rays
 * and fingertip pokes all click them. Hover glow, press-in, an open animation and
 * a feedback hook (haptics/sound) give it the feel of Quest system menus.
 */
export class SpatialPanel {
  readonly root = new Group();
  readonly content = new Group();
  readonly entity: Entity;
  readonly backing: Mesh;
  private els: Element[] = [];
  private openT = 1;
  private aniso: number;
  feedback: Feedback | null = null;

  constructor(
    private world: World,
    readonly width: number,
    readonly height: number,
    opts: { radius?: number; parent?: Entity } = {},
  ) {
    this.aniso = Math.min(8, world.renderer.capabilities.getMaxAnisotropy());
    this.entity = world.createTransformEntity(this.root, { parent: opts.parent ?? world.sceneEntity, persistent: true });
    this.root.add(this.content);
    // Rounded glass backing.
    const W = Math.round(width * PX_PER_M * 0.5);
    const H = Math.round(height * PX_PER_M * 0.5);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const r = (opts.radius ?? 0.014) * PX_PER_M * 0.5;
    ctx.fillStyle = THEME.bg;
    roundRect(ctx, 1, 1, W - 2, H - 2, r);
    ctx.fill();
    ctx.strokeStyle = THEME.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    this.backing = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.backing.renderOrder = 40;
    this.content.add(this.backing);
    // The whole panel takes the pointer, not just its buttons: the ray and its dot stay
    // on the menu while you move between buttons instead of vanishing in the gaps.
    const back = world.createTransformEntity(this.backing, { parent: this.entity, persistent: true });
    back.addComponent(RayInteractable);
  }

  add(spec: ElementSpec): void {
    const W = Math.max(4, Math.round(spec.w * PX_PER_M));
    const H = Math.max(4, Math.round(spec.h * PX_PER_M));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = this.aniso;
    const mesh = new Mesh(new PlaneGeometry(spec.w, spec.h), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    mesh.position.set(spec.x, spec.y, 0.001);
    mesh.renderOrder = 41;
    mesh.name = `btn:${spec.id}`;
    this.content.add(mesh);
    const el: Element = { spec, mesh, canvas, texture, W, H, hover: false, pressed: false, lastKey: '', cooldownUntil: 0, shown: true };
    if (spec.onClick) {
      const ent = this.world.createTransformEntity(mesh, { parent: this.entity, persistent: true });
      ent.addComponent(RayInteractable);
      registerPokeButton(ent);
      mesh.addEventListener('pointerenter', () => {
        el.hover = true;
        if (this.isEnabled(el)) this.feedback?.('hover');
        this.draw(el);
      });
      mesh.addEventListener('pointerleave', () => {
        el.hover = false;
        el.pressed = false;
        this.draw(el);
      });
      mesh.addEventListener('pointerdown', () => {
        el.pressed = true;
        this.draw(el);
      });
      mesh.addEventListener('pointerup', () => {
        el.pressed = false;
        this.draw(el);
      });
      mesh.addEventListener('click', () => {
        if (!this.root.visible || !el.shown || !this.isEnabled(el)) return;
        // A fingertip poke and a ray can both report one press; debounce per element.
        const now = performance.now();
        if (now < el.cooldownUntil) return;
        el.cooldownUntil = now + 150;
        this.feedback?.('click');
        spec.onClick?.();
        this.refresh();
      });
    } else {
      mesh.raycast = () => {};
    }
    this.els.push(el);
    this.draw(el);
  }

  private isEnabled(el: Element): boolean {
    return el.spec.enabled?.() ?? true;
  }

  private draw(el: Element): void {
    const st: ElState = {
      hover: el.hover,
      pressed: el.pressed,
      active: el.spec.active?.() ?? false,
      enabled: this.isEnabled(el),
    };
    const key = `${el.spec.key?.() ?? ''}|${st.hover}|${st.pressed}|${st.active}|${st.enabled}`;
    if (key === el.lastKey) return;
    el.lastKey = key;
    const ctx = el.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, el.W, el.H);
    el.spec.render(ctx, el.W, el.H, st);
    el.texture.needsUpdate = true;
    // Press-in: push the element back and shrink it a touch.
    el.mesh.position.z = st.pressed ? -0.002 : 0.001;
    el.mesh.scale.setScalar(st.pressed ? 0.95 : 1);
  }

  /** Re-evaluate visibility, labels and states. Cheap when nothing changed. */
  refresh(): void {
    const panelVisible = this.root.visible;
    for (const el of this.els) {
      const shown = el.spec.visible?.() ?? true;
      if (shown !== el.shown) {
        el.shown = shown;
        el.mesh.visible = shown;
        if (!shown) {
          el.hover = false;
          el.pressed = false;
        }
      }
      el.mesh.pointerEvents = panelVisible && shown && el.spec.onClick ? 'auto' : 'none';
      if (shown) this.draw(el);
    }
  }

  get visible(): boolean {
    return this.root.visible;
  }

  setVisible(v: boolean): void {
    if (this.root.visible === v) return;
    this.root.visible = v;
    if (v) this.openT = 0;
    this.refresh();
  }

  /** Open animation; call every frame. */
  tick(dt: number): void {
    if (this.openT >= 1) return;
    this.openT = Math.min(1, this.openT + dt / 0.14);
    const e = 1 - Math.pow(1 - this.openT, 3);
    this.content.scale.setScalar(0.85 + 0.15 * e);
    const opacity = e;
    for (const m of [this.backing, ...this.els.map((x) => x.mesh)]) (m.material as MeshBasicMaterial).opacity = opacity;
  }
}

// --- Element renderers --------------------------------------------------------

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, px: number, weight = 600): number {
  let size = px;
  ctx.font = `${weight} ${size}px ${THEME.font}`;
  while (size > 8 && ctx.measureText(text).width > maxW) {
    size -= 1;
    ctx.font = `${weight} ${size}px ${THEME.font}`;
  }
  return size;
}

function bgFor(st: ElState, base = THEME.surface, accent = THEME.accent): string {
  if (!st.enabled) return '#1b2029';
  if (st.active) return st.hover ? THEME.accentHover : accent;
  return st.hover ? THEME.surfaceHover : base;
}

/** Big tile: icon above a label (tools). */
export function tileRenderer(icon: IconName, label: () => string) {
  return (ctx: CanvasRenderingContext2D, W: number, H: number, st: ElState) => {
    ctx.fillStyle = bgFor(st);
    roundRect(ctx, 2, 2, W - 4, H - 4, H * 0.18);
    ctx.fill();
    if (st.hover && st.enabled) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    const color = st.enabled ? THEME.text : THEME.disabled;
    drawIcon(ctx, icon, W / 2, H * 0.4, H * 0.42, color);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, label(), W * 0.9, Math.round(H * 0.22));
    ctx.fillText(label(), W / 2, H * 0.81);
  };
}

/** Vertical tab in the left rail: icon + small caption. */
export function tabRenderer(icon: IconName, label: string) {
  return (ctx: CanvasRenderingContext2D, W: number, H: number, st: ElState) => {
    if (st.active || st.hover) {
      ctx.fillStyle = st.active ? 'rgba(61,139,255,0.22)' : 'rgba(255,255,255,0.08)';
      roundRect(ctx, 2, 2, W - 4, H - 4, H * 0.22);
      ctx.fill();
    }
    if (st.active) {
      ctx.fillStyle = THEME.accent;
      roundRect(ctx, 2, H * 0.22, 5, H * 0.56, 3);
      ctx.fill();
    }
    const color = st.active ? '#ffffff' : THEME.textDim;
    drawIcon(ctx, icon, W / 2, H * 0.37, H * 0.42, color);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, label, W * 0.94, Math.round(H * 0.27), 600);
    ctx.fillText(label, W / 2, H * 0.8);
  };
}

/** Pill chip: an option or small action. */
export function chipRenderer(label: () => string, opts: { icon?: IconName; tone?: 'normal' | 'danger' | 'primary' } = {}) {
  return (ctx: CanvasRenderingContext2D, W: number, H: number, st: ElState) => {
    const base = opts.tone === 'danger' ? '#4a2326' : opts.tone === 'primary' ? '#1d4f99' : THEME.surface;
    const accent = opts.tone === 'danger' ? THEME.danger : THEME.accent;
    ctx.fillStyle = st.hover && st.enabled && !st.active && opts.tone ? (opts.tone === 'danger' ? '#6a2c30' : '#2862b8') : bgFor(st, base, accent);
    roundRect(ctx, 2, 2, W - 4, H - 4, (H - 4) / 2);
    ctx.fill();
    const color = st.enabled ? THEME.text : THEME.disabled;
    let x = W / 2;
    const text = label();
    ctx.textBaseline = 'middle';
    const px = fitFont(ctx, text, W * (opts.icon ? 0.68 : 0.86), Math.round(H * 0.44));
    if (opts.icon) {
      const tw = ctx.measureText(text).width;
      const iconS = H * 0.52;
      const total = iconS + 8 + tw;
      const left = (W - total) / 2;
      drawIcon(ctx, opts.icon, left + iconS / 2, H / 2, iconS, color);
      x = left + iconS + 8 + tw / 2;
    }
    ctx.font = `600 ${px}px ${THEME.font}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, H / 2 + 1);
  };
}

/** Round icon button (undo/redo). */
export function roundRenderer(icon: IconName) {
  return (ctx: CanvasRenderingContext2D, W: number, H: number, st: ElState) => {
    ctx.fillStyle = bgFor(st);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    drawIcon(ctx, icon, W / 2, H / 2, H * 0.5, st.enabled ? THEME.text : THEME.disabled);
  };
}

/** Text block. Lines separated by \n; first line is the title. */
export function textRenderer(text: () => string, opts: { align?: CanvasTextAlign; titlePx?: number; bodyPx?: number } = {}) {
  return (ctx: CanvasRenderingContext2D, W: number, H: number) => {
    const lines = text().split('\n');
    const align = opts.align ?? 'left';
    const x = align === 'left' ? 4 : align === 'center' ? W / 2 : W - 4;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    const tp = opts.titlePx ?? Math.round(H * 0.42);
    const bp = opts.bodyPx ?? Math.round(H * 0.3);
    let y = 2;
    lines.forEach((line, i) => {
      const px = i === 0 ? tp : bp;
      fitFont(ctx, line, W - 8, px, i === 0 ? 700 : 500);
      ctx.fillStyle = i === 0 ? THEME.text : THEME.textDim;
      ctx.fillText(line, x, y);
      y += px * 1.25;
    });
  };
}
