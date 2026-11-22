import { encodeRecording, decodeRecording, type DepthFrame, type ScanPhoto } from '../core/scanIngest.js';
import { idbGet, idbSet } from './idb.js';

const KEY = 'scan-rec:v1';
/** ~4 frames a second: about 16 minutes of scanning, ~40 MB. */
const MAX_FRAMES = 4000;

/**
 * Keeps every depth frame of the current scan (until Clear), on the headset
 * only. Saved as a file it replays through the exact scan pipeline, so real
 * basements can become test cases.
 */
export class ScanRecorder {
  private frames: DepthFrame[] = [];
  readonly photos: ScanPhoto[] = [];
  private dirty = false;

  get count(): number {
    return this.frames.length;
  }

  /** Seconds of scanning recorded. */
  get seconds(): number {
    return this.frames.length / 4;
  }

  /** ~1 a second, up to ~16 minutes. */
  addPhoto(p: ScanPhoto): void {
    if (this.photos.length >= 1000) return;
    this.photos.push(p);
    this.dirty = true;
  }

  add(f: DepthFrame): void {
    if (this.frames.length >= MAX_FRAMES) return;
    this.frames.push(f);
    this.dirty = true;
  }

  clear(): void {
    this.frames = [];
    this.photos.length = 0;
    this.dirty = false;
    void idbSet(KEY, new Uint8Array(0));
  }

  async load(): Promise<void> {
    try {
      const bytes = await idbGet<Uint8Array>(KEY);
      if (bytes && bytes.length) {
        const r = decodeRecording(bytes);
        this.frames = r.frames;
        this.photos.push(...r.photos);
      }
    } catch (e) {
      console.warn('[scan] recording unreadable, starting a new one', e);
      this.frames = [];
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await idbSet(KEY, encodeRecording(this.frames, {}, this.photos));
  }

  /** The recording as a gzipped file to download. */
  async toFile(): Promise<Blob | null> {
    if (!this.frames.length) return null;
    const raw = encodeRecording(this.frames, { userAgent: navigator.userAgent }, this.photos);
    return gzipBlob(raw);
  }
}

export async function gzipBlob(raw: Uint8Array): Promise<Blob> {
  const blob = new Blob([raw as BlobPart]);
  if (typeof CompressionStream === 'undefined') return blob;
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
