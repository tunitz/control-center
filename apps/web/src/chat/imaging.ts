export const MAX_SIDE = 2048;
export const MIN_SIDE = 64;
export const MAX_BYTES = 6 * 1024 * 1024;
export const QUALITY_LADDER = [0.92, 0.85, 0.75, 0.6];
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Scales so the longest side is at most `max`. Never upscales. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number; scaled: boolean } {
  const longest = Math.max(w, h);
  if (longest <= max) return { w, h, scaled: false };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

export function tooSmall(w: number, h: number): boolean {
  return Math.min(w, h) < MIN_SIDE;
}

/** PNG only when the image has transparency; everything else is re-encoded as JPEG (smaller). */
export function outputMime(inputMime: string, hasAlpha: boolean): "image/png" | "image/jpeg" {
  return inputMime === "image/png" && hasAlpha ? "image/png" : "image/jpeg";
}

/** Browser only: decode, downscale to <=2048 px longest side, re-encode under MAX_BYTES. Returns a new File. */
export async function prepareImage(file: File): Promise<{ file: File; w: number; h: number; scaled: boolean }> {
  const bmp = await createImageBitmap(file);
  if (tooSmall(bmp.width, bmp.height)) {
    bmp.close();
    throw new Error(`${file.name}: image is smaller than ${MIN_SIDE} px on its shortest side`);
  }
  const size = fitSize(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) { bmp.close(); throw new Error("Canvas is not available in this browser"); }
  ctx.drawImage(bmp, 0, 0, size.w, size.h);
  bmp.close();
  const hasAlpha = file.type === "image/png" && hasTransparency(ctx, size.w, size.h);
  const mime = outputMime(file.type, hasAlpha);
  const ext = mime === "image/png" ? "png" : "jpg";
  const base = file.name.replace(/\.[^.]+$/, "") || "image";
  const ladder = mime === "image/png" ? [1] : QUALITY_LADDER;
  for (const q of ladder) {
    const blob = await toBlob(canvas, mime, q);
    if (blob.size <= MAX_BYTES) return { file: new File([blob], `${base}.${ext}`, { type: mime }), w: size.w, h: size.h, scaled: size.scaled };
  }
  throw new Error(`${file.name}: image is still over 6 MB after resizing`);
}

function toBlob(c: HTMLCanvasElement, mime: string, q: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error("Image encode failed"))), mime, q));
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}
