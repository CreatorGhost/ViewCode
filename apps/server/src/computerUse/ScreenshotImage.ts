// @effect-diagnostics nodeBuiltinImport:off - runs in the plain-Node driver worker.
/**
 * Downscaling and PNG encoding for computer-use screenshots, over the raw
 * RGBA buffer xa11y captures. Plain Node (`zlib`) so the driver worker needs
 * no image dependency: a Retina window is ~2x the size a vision model reads
 * well, and shipping it full size only costs tokens.
 */
import * as NodeZlib from "node:zlib";

/** Dimensions that fit `maxSize` on the longest edge, keeping aspect; never upscales. */
export const fitWithin = (
  width: number,
  height: number,
  maxSize: number,
): { readonly width: number; readonly height: number } => {
  const longest = Math.max(width, height);
  if (longest <= maxSize) return { width, height };
  const factor = maxSize / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
};

/**
 * Box-filter downscale: each target pixel averages the source pixels its
 * footprint covers, which keeps thin UI lines and text legible where
 * nearest-neighbour would drop them.
 */
export const downscaleRgba = (
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array => {
  const target = new Uint8Array(width * height * 4);
  const scaleX = sourceWidth / width;
  const scaleY = sourceHeight / height;
  for (let y = 0; y < height; y += 1) {
    const top = Math.floor(y * scaleY);
    const bottom = Math.min(sourceHeight, Math.max(top + 1, Math.floor((y + 1) * scaleY)));
    for (let x = 0; x < width; x += 1) {
      const left = Math.floor(x * scaleX);
      const right = Math.min(sourceWidth, Math.max(left + 1, Math.floor((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = top; sy < bottom; sy += 1) {
        let offset = (sy * sourceWidth + left) * 4;
        for (let sx = left; sx < right; sx += 1) {
          r += source[offset]!;
          g += source[offset + 1]!;
          b += source[offset + 2]!;
          a += source[offset + 3]!;
          offset += 4;
        }
      }
      const count = (bottom - top) * (right - left);
      const out = (y * width + x) * 4;
      target[out] = Math.round(r / count);
      target[out + 1] = Math.round(g / count);
      target[out + 2] = Math.round(b / count);
      target[out + 3] = Math.round(a / count);
    }
  }
  return target;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Buffer => {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(typed.length + 8);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), typed.length + 4);
  return out;
};

/** Encodes 8-bit RGBA pixels as a PNG (filter 0 on every row). */
export const encodePng = (rgba: Uint8Array, width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rowLength = width * 4;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowLength + 1)] = 0;
    raw.set(rgba.subarray(y * rowLength, (y + 1) * rowLength), y * (rowLength + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
};
