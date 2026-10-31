// One-off generator for the Android notification icon.
// Android renders this as a monochrome mask: it must be a 96x96 all-white PNG
// with a transparent background. Run with `node tools/make-notification-icon.mjs`.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SIZE = 96;
const SAMPLES = 4; // 4x4 supersampling for smooth edges

// --- shape definition (unit coordinates in pixels of the 96x96 canvas) -------
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const roundedRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
};

// A bell: knob, dome, body, rim, clapper.
const shape = [
  circle(48, 16, 5),
  circle(48, 44, 23),
  roundedRect(25, 44, 71, 70, 6),
  roundedRect(17, 69, 79, 77, 4),
  circle(48, 85, 6),
];

const coverage = (x, y) => (shape.some((test) => test(x, y)) ? 1 : 0);

// --- PNG encoding -----------------------------------------------------------
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[offset++] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    let hits = 0;
    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        hits += coverage(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
      }
    }
    const alpha = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    if (process.env.PREVIEW) {
      // Composite over dark grey so the white glyph is visible in a preview.
      const a = alpha / 255;
      raw[offset++] = Math.round(255 * a + 27 * (1 - a));
      raw[offset++] = Math.round(255 * a + 27 * (1 - a));
      raw[offset++] = Math.round(255 * a + 27 * (1 - a));
    } else {
      raw[offset++] = 255; // white
      raw[offset++] = 255;
      raw[offset++] = 255;
    }
    raw[offset++] = alpha;
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = process.env.PREVIEW_PATH
  ? pathToFileURL(process.env.PREVIEW_PATH)
  : new URL("../assets/images/icons/notification-icon.png", import.meta.url);
writeFileSync(target, png);
console.log(`wrote ${target.pathname} (${png.length} bytes)`);
