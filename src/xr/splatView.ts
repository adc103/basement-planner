import type { Object3D, Scene, WebGLRenderer } from '@iwsdk/core';
import { idbGet, idbSet } from './idb.js';

const KEY = 'splat:v1';

interface Stored {
  name: string;
  bytes: ArrayBuffer;
}

/**
 * A Gaussian splat of the room, shown 1:1 over it. Trained from this app's own scan
 * (same coordinates as the plan root) or any .ply / .spz. Spark (World Labs' three.js
 * splat renderer, MIT) draws it; it is loaded only when a splat is used.
 */
export class SplatView {
  name: string | null = null;
  shown = false;
  private mesh: Object3D | null = null;
  private spark: Object3D | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private root: Object3D,
    private scene: Scene,
    private renderer: WebGLRenderer,
  ) {}

  /** A splat saved on this headset earlier (name only; it loads when shown). */
  async restore(): Promise<void> {
    const s = await idbGet<Stored>(KEY);
    if (s) this.name = s.name;
  }

  /** Keep a splat file on this headset and use it. */
  async save(name: string, bytes: ArrayBuffer): Promise<void> {
    await idbSet(KEY, { name, bytes } satisfies Stored);
    this.name = name;
    this.dispose();
    if (this.shown) await this.ensure();
  }

  get available(): boolean {
    return this.name !== null;
  }

  async setShown(on: boolean): Promise<void> {
    this.shown = on;
    if (on) await this.ensure();
    if (this.mesh) this.mesh.visible = on;
  }

  private ensure(): Promise<void> {
    if (this.mesh) return Promise.resolve();
    if (!this.loading) {
      this.loading = (async () => {
        const s = await idbGet<Stored>(KEY);
        if (!s) return;
        const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
        if (!this.spark) {
          const spark = new SparkRenderer({ renderer: this.renderer as never });
          this.scene.add(spark as never);
          this.spark = spark as never;
        }
        const mesh = new SplatMesh({ fileBytes: new Uint8Array(s.bytes), fileName: s.name } as never);
        await (mesh as unknown as { initialized: Promise<unknown> }).initialized;
        (mesh as unknown as Object3D).visible = this.shown;
        this.root.add(mesh as unknown as Object3D);
        this.mesh = mesh as unknown as Object3D;
      })().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private dispose(): void {
    if (!this.mesh) return;
    this.root.remove(this.mesh);
    (this.mesh as unknown as { dispose?: () => void }).dispose?.();
    this.mesh = null;
  }
}
