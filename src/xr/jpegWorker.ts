/** JPEG encoding off the main thread (the browser's own encoder, via OffscreenCanvas). */
export interface JpegIn {
  id: number;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  quality: number;
}
export interface JpegOut {
  id: number;
  jpeg: Uint8Array | null;
}

const canvas = new OffscreenCanvas(2, 2);
const ctx = canvas.getContext('2d')!;
self.onmessage = async (e: MessageEvent<JpegIn>) => {
  const { id, rgba, w, h, quality } = e.data;
  let jpeg: Uint8Array | null = null;
  try {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    jpeg = new Uint8Array(await blob.arrayBuffer());
  } catch {
    jpeg = null;
  }
  const out: JpegOut = { id, jpeg };
  (self as unknown as Worker).postMessage(out, jpeg ? [jpeg.buffer] : []);
};
