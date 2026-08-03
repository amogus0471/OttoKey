// Dependency-free PNG icon generator for OttoKey.
// Draws the OttoKey mark - a teal key: ring bow, diagonal shaft, two teeth -
// exactly matching the SVG used in the popup and on the website. Rendered from
// signed distance fields at 4x supersampling, encoded with Node's zlib.
//
//   node tools/make-icons.cjs            -> icons/icon{16,48,128,256}.png
//   node tools/make-icons.cjs --og       -> also the 1200x630 social image
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "icons");
fs.mkdirSync(OUT, { recursive: true });

const TEAL = [0x14, 0xb8, 0xa6];
const WHITE = [255, 255, 255];

// ---- the mark, in a 64x64 design box (same numbers as the SVG) --------------
const STROKE = 7.5;             // line thickness
const RING = { cx: 23, cy: 23, r: 12.5 };
const LINES = [
  [32, 32, 52, 52],             // shaft
  [43.5, 43.5, 50, 37],         // upper tooth
  [49, 49, 55.5, 42.5]          // lower tooth
];

// Distance from a point to a line segment (round caps come for free).
function distToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx - x, py = y1 + t * dy - y;
  return Math.hypot(px, py);
}

// Signed distance to the mark: negative inside, positive outside.
function markDistance(x, y) {
  // Ring: distance to the circle outline, then to its half-thickness.
  let d = Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r) - STROKE / 2;
  for (const [x1, y1, x2, y2] of LINES) {
    d = Math.min(d, distToSegment(x, y, x1, y1, x2, y2) - STROKE / 2);
  }
  return d;
}

// ---- supersampled raster ---------------------------------------------------
// `pad` leaves breathing room so the mark is not flush against the tile edge;
// `bg` is null for a transparent icon or an [r,g,b] tuple for a filled canvas.
function render(width, height = width, { pad = 5, bg = null } = {}) {
  const SS = 4;
  const box = 64 + pad * 2;
  const scale = Math.min(width, height) / box;
  const offX = (width - box * scale) / 2;
  const offY = (height - box * scale) / 2;
  const out = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS - offX) / scale - pad;
          const py = (y + (sy + 0.5) / SS - offY) / scale - pad;
          if (markDistance(px, py) <= 0) cover++;
        }
      }
      const a = cover / (SS * SS);
      const i = (y * width + x) * 4;
      if (bg) {
        out[i] = Math.round(bg[0] + (TEAL[0] - bg[0]) * a);
        out[i + 1] = Math.round(bg[1] + (TEAL[1] - bg[1]) * a);
        out[i + 2] = Math.round(bg[2] + (TEAL[2] - bg[2]) * a);
        out[i + 3] = 255;
      } else {
        out[i] = TEAL[0]; out[i + 1] = TEAL[1]; out[i + 2] = TEAL[2];
        out[i + 3] = Math.round(a * 255);
      }
    }
  }
  return out;
}

// ---- minimal PNG encoder ---------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(rgba, width, height = width) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;                      // 8-bit RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;                          // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const write = (file, rgba, w, h) => {
  fs.writeFileSync(file, encodePng(rgba, w, h));
  console.log(`wrote ${path.relative(path.join(__dirname, ".."), file)} (${w}x${h})`);
};

for (const size of [16, 48, 128, 256]) {
  // Small sizes get less padding so the mark stays legible in the toolbar.
  const pad = size <= 16 ? 2 : size <= 48 ? 4 : 5;
  write(path.join(OUT, `icon${size}.png`), render(size, size, { pad }), size, size);
}

if (process.argv.includes("--og")) {
  const site = path.join(__dirname, "..", "..", "Jeanlucponsard.dev", "public", "otto");
  if (fs.existsSync(site)) {
    write(path.join(site, "ottokey-512.png"), render(512, 512, { pad: 6 }), 512, 512);
    write(path.join(site, "ottokey-og.png"), render(1200, 630, { pad: 26, bg: WHITE }), 1200, 630);
  } else {
    console.log(`skipped social images: ${site} not found`);
  }
}
