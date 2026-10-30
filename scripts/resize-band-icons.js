#!/usr/bin/env node
"use strict";

// Resize the 14 navigation direction icons to the native display size used on
// Xiaomi Smart Band 10 PRO (336x480, Vela 5.0). With designWidth=192 and the
// .nav-icon element declared at 140px in the .ux, the band renders it at
// 140 * 336/192 = 245 physical px, so 245x245 is the native bitmap size that
// avoids runtime upscaling. Pure Node built-ins only: PNG decode/encode is done
// here with zlib, no image library and no external tool.
//
// Contract AC4:
//   * output is 8-bit, color type 6 (RGBA), non-interlaced PNG
//   * decode supports row filters 0..4
//   * interpolation is bilinear in premultiplied-alpha space, edge clamped
//   * already 140x140 input prints "already-converted" and exits 0 (repeatable)
//   * each file prints before/after size and mean alpha plus the ratio, and a
//     ratio outside +/-3% fails the run
//
// Only the 14 ACTION_LABELS ids are touched; no other image is added/removed.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const REPO_ROOT = path.resolve(__dirname, "..");
const IMAGES_DIR = path.join(REPO_ROOT, "band-app", "src", "common", "images");
const CODEC_PATH = path.join(REPO_ROOT, "band-app", "src", "common", "codec.js");

const TARGET = 245;
const MEAN_ALPHA_TOLERANCE = 0.03; // +/-3%

// The authoritative id list is the read-only ACTION_LABELS map in the codec, so
// this script can never drift from the actions the page renders.
const { ACTION_LABELS } = require(CODEC_PATH);
const ACTION_IDS = Object.keys(ACTION_LABELS);

// ---------------------------------------------------------------------------
// PNG decode (bit depth 8, color type 6, no interlace)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file (bad signature)");
  }
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error("truncated PNG chunk " + type);
    }
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd) });
    off = dataEnd + 4; // skip CRC
    if (type === "IEND") {
      break;
    }
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

// Undo the per-scanline filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth).
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4:
          value = rawByte + paeth(left, up, upLeft);
          break;
        default:
          throw new Error("unsupported PNG row filter " + filter + " at row " + y);
      }
      out[rowStart + x] = value & 0xff;
    }
    pos += stride;
  }
  return out;
}

function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) {
    throw new Error("PNG has no IHDR chunk");
  }
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error("unsupported PNG format: bitDepth=" + bitDepth + " colorType=" + colorType);
  }
  if (compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new Error(
      "unsupported PNG encoding: compression=" + compression +
      " filter=" + filterMethod + " interlace=" + interlace
    );
  }
  const idatParts = chunks.filter((c) => c.type === "IDAT").map((c) => c.data);
  if (idatParts.length === 0) {
    throw new Error("PNG has no IDAT chunk");
  }
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) {
    throw new Error("unexpected inflated size " + raw.length + " for " + width + "x" + height);
  }
  return { width, height, pixels: unfilter(raw, width, height, 4) };
}

// ---------------------------------------------------------------------------
// PNG encode (8-bit RGBA, filter type 0 on every scanline)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// Resample: bilinear in premultiplied alpha space, edge clamped
// ---------------------------------------------------------------------------

function srcIndex(coord, count) {
  // Center-aligned mapping from destination pixel to source coordinate.
  const fx = (coord + 0.5) * (count / TARGET) - 0.5;
  let i0 = Math.floor(fx);
  let frac = fx - i0;
  if (i0 < 0) {
    i0 = 0;
    frac = 0;
  } else if (i0 >= count - 1) {
    i0 = count - 1;
    frac = 0;
  }
  const i1 = Math.min(i0 + 1, count - 1);
  return { i0, i1, frac };
}

function resample(src, srcWidth, srcHeight) {
  const out = Buffer.alloc(TARGET * TARGET * 4);
  const xs = new Array(TARGET);
  const ys = new Array(TARGET);
  for (let x = 0; x < TARGET; x++) {
    xs[x] = srcIndex(x, srcWidth);
  }
  for (let y = 0; y < TARGET; y++) {
    ys[y] = srcIndex(y, srcHeight);
  }

  for (let dy = 0; dy < TARGET; dy++) {
    const { i0: y0, i1: y1, frac: ty } = ys[dy];
    for (let dx = 0; dx < TARGET; dx++) {
      const { i0: x0, i1: x1, frac: tx } = xs[dx];
      // Premultiply the four corners, interpolate, then unpremultiply.
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      const corners = [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty]
      ];
      for (const [cx, cy, weight] of corners) {
        if (weight === 0) {
          continue;
        }
        const at = (cy * srcWidth + cx) * 4;
        const a = src[at + 3];
        const af = a / 255;
        pr += src[at] * af * weight;
        pg += src[at + 1] * af * weight;
        pb += src[at + 2] * af * weight;
        pa += a * weight;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (pa > 0) {
        const scale = 255 / pa;
        r = Math.round(pr * scale);
        g = Math.round(pg * scale);
        b = Math.round(pb * scale);
        a = Math.round(pa);
      }
      const at = (dy * TARGET + dx) * 4;
      out[at] = Math.min(255, Math.max(0, r));
      out[at + 1] = Math.min(255, Math.max(0, g));
      out[at + 2] = Math.min(255, Math.max(0, b));
      out[at + 3] = Math.min(255, Math.max(0, a));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mean alpha (alpha sum over pixel count) as the coverage proxy
// ---------------------------------------------------------------------------

function meanAlpha(pixels) {
  let sum = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    sum += pixels[i];
  }
  return sum / (pixels.length / 4);
}

// ---------------------------------------------------------------------------

// Returns 
// Convert one icon in place. Returns "converted", "already-converted" or
// "failed" so the caller can both report and enforce the coverage tolerance.
function convertIcon(id, { write }) {
  const file = path.join(IMAGES_DIR, id + ".png");
  if (!fs.existsSync(file)) {
    throw new Error("missing icon " + file);
  }
  const decoded = decodePng(fs.readFileSync(file));
  const srcMean = meanAlpha(decoded.pixels);

  if (decoded.width === TARGET && decoded.height === TARGET) {
    console.log(
      id + ".png: " + decoded.width + "x" + decoded.height +
      " -> already-converted (meanAlpha " + srcMean.toFixed(6) + " ratio 1.0000)"
    );
    return "already-converted";
  }

  const resized = resample(decoded.pixels, decoded.width, decoded.height);
  const dstMean = meanAlpha(resized);
  const ratio = dstMean / srcMean;

  console.log(
    id + ".png: " + decoded.width + "x" + decoded.height + " -> " +
    TARGET + "x" + TARGET +
    " meanAlpha " + srcMean.toFixed(6) + " -> " + dstMean.toFixed(6) +
    " ratio=" + ratio.toFixed(4)
  );

  if (!(ratio >= 1 - MEAN_ALPHA_TOLERANCE && ratio <= 1 + MEAN_ALPHA_TOLERANCE)) {
    console.error(
      "FAIL " + id + ".png: mean alpha ratio " + ratio.toFixed(4) +
      " outside +/-" + MEAN_ALPHA_TOLERANCE
    );
    return "failed";
  }

  if (write) {
    fs.writeFileSync(file, encodePng(TARGET, TARGET, resized));
  }
  return "converted";
}

function main() {
  if (ACTION_IDS.length !== 14) {
    throw new Error("expected 14 ACTION_LABELS ids, got " + ACTION_IDS.length);
  }

  let converted = 0;
  let already = 0;
  let failed = 0;
  let failures = 0;

  for (const id of ACTION_IDS) {
    const outcome = convertIcon(id, { write: true });
    if (outcome === "converted") {
      converted++;
    } else if (outcome === "already-converted") {
      already++;
    } else {
      failures++;
    }
  }

  // Idempotency self-check in the same invocation: re-run the conversion for
  // the first icon straight from disk without writing. If the file we just
  // produced is a true 140x140 RGBA PNG the pass must report already-converted,
  // so a repeat run changes nothing.
  const probeId = ACTION_IDS[0];
  const probe = convertIcon(probeId, { write: false });
  if (probe !== "already-converted") {
    failures++;
    console.error(
      "FAIL idempotency: re-running " + probeId + ".png reported " + probe +
      ", expected already-converted"
    );
  } else {
    console.log("idempotency self-check: " + probeId + ".png reports already-converted");
  }

  console.log(
    "resize-band-icons: " + converted + " converted, " + already +
    " already-converted, " + failed + " failed, " + failures + " failures"
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main();
