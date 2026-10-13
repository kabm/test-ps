// Image decoding (JPEG/PNG/WebP/GIF/BMP/AVIF natively, TIFF via UTIF, camera RAW
// via the embedded full-size JPEG preview) and a small EXIF reader.

import UTIF from 'utif';
import { createCanvas, canvasFromImage, fitSize } from './util.js';
import { extOf, RAW_EXTS, osDecode } from './platform.js';

// ---------------------------------------------------------------------------
// EXIF / TIFF tag reading

const TAGS = {
  0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x0132: 'dateTime',
  0x8769: 'exifIFD', 0x829a: 'exposureTime', 0x829d: 'fNumber', 0x8827: 'iso',
  0x9003: 'dateTimeOriginal', 0x920a: 'focalLength', 0xa434: 'lensModel', 0x9204: 'exposureBias',
  0xa002: 'pixelWidth', 0xa003: 'pixelHeight', 0xa405: 'focalLength35',
};

function readTiffTags(view, tiffStart, maxLen) {
  const out = {};
  if (tiffStart + 8 > view.byteLength) return out;
  const bo = view.getUint16(tiffStart);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return out;
  const u16 = (o) => view.getUint16(tiffStart + o, le);
  const u32 = (o) => view.getUint32(tiffStart + o, le);
  const limit = Math.min(view.byteLength - tiffStart, maxLen || Infinity);
  const readIFD = (off, depth) => {
    if (depth > 2 || off <= 0 || off + 2 > limit) return;
    const n = u16(off);
    if (n > 500) return;
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > limit) return;
      const tag = u16(e);
      const name = TAGS[tag];
      if (!name) continue;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const sz = (sizes[type] || 1) * count;
      const valOff = sz <= 4 ? e + 8 : u32(e + 8);
      if (valOff + sz > limit) continue;
      let v;
      if (type === 2) {
        let s = '';
        for (let k = 0; k < count - 1; k++) s += String.fromCharCode(view.getUint8(tiffStart + valOff + k));
        v = s.trim();
      } else if (type === 3) v = u16(valOff);
      else if (type === 4 || type === 9) v = u32(valOff);
      else if (type === 5 || type === 10) {
        const num = type === 5 ? u32(valOff) : view.getInt32(tiffStart + valOff, le);
        const den = type === 5 ? u32(valOff + 4) : view.getInt32(tiffStart + valOff + 4, le);
        v = den ? num / den : 0;
        if (name === 'exposureTime') out.exposureTimeRaw = [num, den];
      } else v = view.getUint8(tiffStart + valOff);
      if (name === 'exifIFD') readIFD(v, depth + 1);
      else if (out[name] === undefined) out[name] = v;
    }
  };
  readIFD(u32(4), 0);
  return out;
}

export function readExif(buffer) {
  const view = new DataView(buffer);
  try {
    if (view.byteLength < 12) return null;
    const b0 = view.getUint16(0);
    if (b0 === 0xffd8) {
      let p = 2;
      while (p + 4 < view.byteLength) {
        if (view.getUint8(p) !== 0xff) return null;
        const marker = view.getUint8(p + 1);
        const len = view.getUint16(p + 2);
        if (marker === 0xe1 && view.getUint32(p + 4) === 0x45786966) {
          return readTiffTags(view, p + 10, len - 8);
        }
        if (marker === 0xda || marker === 0xd9) return null;
        p += 2 + len;
      }
      return null;
    }
    if (b0 === 0x4949 || b0 === 0x4d4d) return readTiffTags(view, 0);
    // Fujifilm RAF: embedded JPEG offset at 84
    if (String.fromCharCode(...new Uint8Array(buffer, 0, 8)) === 'FUJIFILM') {
      const off = view.getUint32(84);
      const len = view.getUint32(88);
      return readExif(buffer.slice(off, off + len));
    }
  } catch {
    return null;
  }
  return null;
}

export function formatExif(e) {
  if (!e) return [];
  const rows = [];
  const cam = [e.make, e.model].filter(Boolean).join(' ').replace(/^(\w+)\s+\1/i, '$1');
  if (cam) rows.push(['Camera', cam]);
  if (e.lensModel) rows.push(['Lens', e.lensModel]);
  if (e.focalLength) rows.push(['Focal length', Math.round(e.focalLength) + ' mm']);
  if (e.fNumber) rows.push(['Aperture', 'f/' + (Math.round(e.fNumber * 10) / 10)]);
  if (e.exposureTime) {
    const t = e.exposureTime;
    rows.push(['Shutter', t >= 1 ? t.toFixed(1).replace(/\.0$/, '') + ' s' : '1/' + Math.round(1 / t) + ' s']);
  }
  if (e.iso) rows.push(['ISO', String(e.iso)]);
  if (e.exposureBias) rows.push(['Exposure bias', (e.exposureBias > 0 ? '+' : '') + e.exposureBias.toFixed(1) + ' EV']);
  const date = e.dateTimeOriginal || e.dateTime;
  if (date) rows.push(['Captured', date.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')]);
  return rows;
}

export function exifSummary(e) {
  if (!e) return '';
  const parts = [];
  if (e.iso) parts.push('ISO ' + e.iso);
  if (e.focalLength) parts.push(Math.round(e.focalLength) + ' mm');
  if (e.fNumber) parts.push('f/' + (Math.round(e.fNumber * 10) / 10));
  if (e.exposureTime) parts.push(e.exposureTime >= 1 ? e.exposureTime + 's' : '1/' + Math.round(1 / e.exposureTime) + 's');
  return parts.join('   ');
}

export function exifDate(e) {
  const s = e && (e.dateTimeOriginal || e.dateTime);
  if (!s) return 0;
  const m = /^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

// ---------------------------------------------------------------------------
// Embedded JPEG extraction (camera RAW files)

function jpegInfo(u8, start) {
  const len = u8.length;
  let p = start + 2;
  let width = 0;
  let height = 0;
  let sof = 0;
  let guard = 0;
  while (p + 3 < len && guard++ < 100000) {
    if (u8[p] !== 0xff) return null;
    while (u8[p] === 0xff && p + 1 < len) p++;
    const marker = u8[p];
    p++;
    if (marker === 0xd9) return { start, end: p, width, height, sof };
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (p + 1 >= len) return null;
    const segLen = (u8[p] << 8) | u8[p + 1];
    if (segLen < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      sof = marker;
      height = (u8[p + 3] << 8) | u8[p + 4];
      width = (u8[p + 5] << 8) | u8[p + 6];
    }
    p += segLen;
    if (marker === 0xda) {
      // entropy-coded data until the next real marker
      while (p + 1 < len) {
        if (u8[p] === 0xff) {
          const m = u8[p + 1];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
          break;
        }
        p++;
      }
    }
  }
  return null;
}

export function findEmbeddedJpegs(buffer) {
  const u8 = new Uint8Array(buffer);
  const found = [];
  for (let i = 0; i + 3 < u8.length; i++) {
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) {
      const info = jpegInfo(u8, i);
      if (info && info.width && info.height) {
        // baseline / extended / progressive only (skip lossless raw data)
        if (info.sof === 0xc0 || info.sof === 0xc1 || info.sof === 0xc2) found.push(info);
        i = info.end - 1;
      }
    }
  }
  found.sort((a, b) => b.width * b.height - a.width * a.height);
  return found;
}

// ---------------------------------------------------------------------------
// Orientation

function orientCanvas(src, orientation) {
  if (!orientation || orientation === 1) return src;
  const swap = orientation >= 5;
  const w = swap ? src.height : src.width;
  const h = swap ? src.width : src.height;
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  switch (orientation) {
    case 2: g.transform(-1, 0, 0, 1, w, 0); break;
    case 3: g.transform(-1, 0, 0, -1, w, h); break;
    case 4: g.transform(1, 0, 0, -1, 0, h); break;
    case 5: g.transform(0, 1, 1, 0, 0, 0); break;
    case 6: g.transform(0, 1, -1, 0, w, 0); break;
    case 7: g.transform(0, -1, -1, 0, w, h); break;
    case 8: g.transform(0, -1, 1, 0, 0, h); break;
    default: break;
  }
  g.drawImage(src, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// Decoding

async function decodeNative(blob) {
  return createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
}

function decodeTiff(buffer) {
  const ifds = UTIF.decode(buffer);
  if (!ifds.length) throw new Error('Not a readable TIFF file');
  let best = null;
  for (const ifd of ifds) {
    const w = ifd.t256 ? ifd.t256[0] : 0;
    const h = ifd.t257 ? ifd.t257[0] : 0;
    if (!best || w * h > best.w * best.h) best = { ifd, w, h };
  }
  UTIF.decodeImage(buffer, best.ifd, ifds);
  const rgba = UTIF.toRGBA8(best.ifd);
  const w = best.ifd.width;
  const h = best.ifd.height;
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h);
  g.putImageData(img, 0, 0);
  const orient = best.ifd.t274 ? best.ifd.t274[0] : 1;
  return orientCanvas(c, orient);
}

export const MAX_DIMENSION = 16000;

// Decode an image file. Returns { canvas, exif, isRaw, note }.
export async function decodeImage(buffer, name, { maxEdge = 0 } = {}) {
  const ext = extOf(name);
  const exif = readExif(buffer);
  let canvas = null;
  let isRaw = false;
  let note = '';

  if (RAW_EXTS.includes(ext)) {
    isRaw = true;
    const jpegs = findEmbeddedJpegs(buffer);
    for (const j of jpegs) {
      try {
        const slice = buffer.slice(j.start, j.end);
        const innerExif = readExif(slice);
        const bmp = await decodeNative(new Blob([slice], { type: 'image/jpeg' }));
        canvas = canvasFromImage(bmp);
        bmp.close?.();
        if (!(innerExif && innerExif.orientation) && exif && exif.orientation) {
          canvas = orientCanvas(canvas, exif.orientation);
        }
        note = 'RAW file: using the camera’s embedded full-size preview.';
        break;
      } catch { /* try next */ }
    }
    if (!canvas && (ext === 'dng' || exif)) {
      try { canvas = decodeTiff(buffer); } catch { /* fall through */ }
    }
    if (!canvas) throw new Error('This RAW file has no readable embedded preview.');
  } else if (ext === 'tif' || ext === 'tiff') {
    canvas = decodeTiff(buffer);
  } else if (ext === 'heic' || ext === 'heif') {
    let bmp;
    try {
      // some HEIF variants (e.g. AVIF-in-HEIF) decode natively
      bmp = await decodeNative(new Blob([buffer]));
    } catch {
      const jpeg = await osDecode(buffer, ext);
      bmp = await decodeNative(new Blob([jpeg], { type: 'image/jpeg' }));
    }
    canvas = canvasFromImage(bmp);
    bmp.close?.();
  } else {
    const bmp = await decodeNative(new Blob([buffer]));
    canvas = canvasFromImage(bmp);
    bmp.close?.();
  }

  const limit = maxEdge || MAX_DIMENSION;
  if (canvas.width > limit || canvas.height > limit) {
    const f = fitSize(canvas.width, canvas.height, limit);
    const c = createCanvas(f.w, f.h);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, f.w, f.h);
    if (!maxEdge) note = (note ? note + ' ' : '') + `Image was resized to ${f.w}×${f.h} to fit in memory.`;
    canvas = c;
  }
  return { canvas, exif, isRaw, note };
}

export function encodeTiff(canvas) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  return UTIF.encodeImage(d, canvas.width, canvas.height);
}
