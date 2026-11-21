import { CanvasTexture, Sprite, SpriteMaterial, SRGBColorSpace } from '@iwsdk/core';

export interface LabelStyle {
  fg?: string;
  bg?: string;
  /** World height of the label in meters. */
  height?: number;
  fontPx?: number;
  bold?: boolean;
}

/**
 * A camera-facing text label (THREE.Sprite with a canvas texture).
 * Call setText() to update; the texture is redrawn only on change.
 */
export class TextLabel {
  /** Set once from the renderer; sharper text at grazing angles. */
  static anisotropy = 1;
  readonly sprite: Sprite;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  private text = '';
  private style: Required<LabelStyle>;

  constructor(text: string, style: LabelStyle = {}) {
    this.style = {
      fg: style.fg ?? '#ffffff',
      bg: style.bg ?? 'rgba(20,24,32,0.82)',
      height: style.height ?? 0.06,
      fontPx: style.fontPx ?? 64,
      bold: style.bold ?? true,
    };
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = TextLabel.anisotropy;
    const mat = new SpriteMaterial({ map: this.texture, depthTest: false, depthWrite: false, transparent: true });
    this.sprite = new Sprite(mat);
    this.sprite.renderOrder = 20;
    this.sprite.pointerEvents = 'none';
    this.setText(text);
  }

  setText(text: string, fg?: string): void {
    if (text === this.text && !fg) return;
    this.text = text;
    if (fg) this.style.fg = fg;
    const { fontPx, bold } = this.style;
    const font = `${bold ? '600 ' : ''}${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    this.ctx.font = font;
    const padX = fontPx * 0.45;
    const padY = fontPx * 0.28;
    const w = Math.ceil(this.ctx.measureText(text).width + padX * 2);
    const h = Math.ceil(fontPx + padY * 2);
    this.canvas.width = Math.max(2, w);
    this.canvas.height = Math.max(2, h);
    const ctx = this.ctx;
    ctx.font = font;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.style.bg;
    roundRect(ctx, 0, 0, w, h, h * 0.3);
    ctx.fill();
    ctx.fillStyle = this.style.fg;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2 + fontPx * 0.04);
    this.texture.dispose();
    this.texture.image = this.canvas;
    this.texture.needsUpdate = true;
    const H = this.style.height;
    this.sprite.scale.set((H * w) / h, H, 1);
  }

  dispose(): void {
    this.texture.dispose();
    (this.sprite.material as SpriteMaterial).dispose();
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
