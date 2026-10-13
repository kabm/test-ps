// Selection helpers. A selection is a doc-sized canvas whose alpha channel is the mask.

import { createCanvas } from './util.js';
import { selectionBounds } from './document.js';

export function newSelectionCanvas(doc) {
  return createCanvas(doc.width, doc.height);
}

// mode: 'replace' | 'add' | 'subtract' | 'intersect'
export function combineSelection(doc, shapeCanvas, mode = 'replace') {
  if (!doc.selection) return mode === 'subtract' || mode === 'intersect' ? null : shapeCanvas;
  if (mode === 'replace') return shapeCanvas;
  const out = createCanvas(doc.width, doc.height);
  const g = out.getContext('2d');
  g.drawImage(doc.selection, 0, 0);
  g.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  g.drawImage(shapeCanvas, 0, 0);
  return out;
}

export function shapeSelection(doc, drawPath, feather = 0) {
  const c = newSelectionCanvas(doc);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  if (feather > 0) g.filter = `blur(${feather}px)`;
  g.beginPath();
  drawPath(g);
  g.fill();
  return c;
}

export function selectAll(doc) {
  const c = newSelectionCanvas(doc);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

export function invertSelection(doc) {
  const c = selectAll(doc);
  if (doc.selection) {
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(doc.selection, 0, 0);
  }
  return c;
}

export function featherSelection(sel, radius) {
  const c = createCanvas(sel.width, sel.height);
  const g = c.getContext('2d');
  g.filter = `blur(${radius}px)`;
  g.drawImage(sel, 0, 0);
  return c;
}

// Grow (positive) or shrink (negative) using blur + threshold.
export function growSelection(sel, px) {
  const r = Math.abs(px);
  const blurred = featherSelection(sel, r / 2);
  const g = blurred.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, blurred.width, blurred.height);
  const d = img.data;
  const thr = px > 0 ? 8 : 247;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i] > thr ? 255 : 0;
    d[i - 3] = d[i - 2] = d[i - 1] = 255;
    d[i] = a;
  }
  g.putImageData(img, 0, 0);
  return blurred;
}

// Selection mapped into a layer's local coordinate space (same size as layer canvas).
export function selectionForLayer(doc, layer) {
  if (!doc.selection) return null;
  if (layer.x === 0 && layer.y === 0 && layer.width === doc.width && layer.height === doc.height) return doc.selection;
  const c = createCanvas(layer.width, layer.height);
  c.getContext('2d').drawImage(doc.selection, -layer.x, -layer.y);
  return c;
}

export function isSelectionEmpty(sel) {
  return !sel || !selectionBounds(sel);
}

// Vectorise the selection boundary into merged horizontal/vertical segments
// (in document pixel coordinates) for drawing "marching ants".
export function selectionOutline(sel) {
  if (sel._outline) return sel._outline;
  const b = selectionBounds(sel);
  if (!b) {
    sel._outline = new Float32Array(0);
    return sel._outline;
  }
  let scale = 1;
  const area = b.w * b.h;
  if (area > 16e6) scale = Math.sqrt(16e6 / area);
  const x0 = Math.max(0, b.x - 1);
  const y0 = Math.max(0, b.y - 1);
  const w = Math.min(sel.width, b.x + b.w + 1) - x0;
  const h = Math.min(sel.height, b.y + b.h + 1) - y0;
  let data;
  let W = w;
  let H = h;
  if (scale < 1) {
    W = Math.max(1, Math.round(w * scale));
    H = Math.max(1, Math.round(h * scale));
    const t = createCanvas(W, H);
    const tg = t.getContext('2d', { willReadFrequently: true });
    tg.drawImage(sel, x0, y0, w, h, 0, 0, W, H);
    data = tg.getImageData(0, 0, W, H).data;
  } else {
    data = sel.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  }
  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] >= 128;
  const segs = [];
  const sx = w / W;
  const sy = h / H;
  // horizontal edges
  for (let y = 0; y <= H; y++) {
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const edge = x < W && inside(x, y - 1) !== inside(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        segs.push(x0 + start * sx, y0 + y * sy, x0 + x * sx, y0 + y * sy);
        start = -1;
      }
    }
  }
  // vertical edges
  for (let x = 0; x <= W; x++) {
    let start = -1;
    for (let y = 0; y <= H; y++) {
      const edge = y < H && inside(x - 1, y) !== inside(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        segs.push(x0 + x * sx, y0 + start * sy, x0 + x * sx, y0 + y * sy);
        start = -1;
      }
    }
  }
  sel._outline = new Float32Array(segs);
  return sel._outline;
}

// Flood fill / magic wand. Returns a Uint8Array mask (w*h) of selected pixels.
export function floodMask(imageData, sx, sy, tolerance, contiguous = true) {
  const { width: w, height: h, data: d } = imageData;
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const i0 = (sy * w + sx) * 4;
  const r0 = d[i0];
  const g0 = d[i0 + 1];
  const b0 = d[i0 + 2];
  const a0 = d[i0 + 3];
  const tol = tolerance * tolerance * 3;
  const match = (p) => {
    const i = p * 4;
    const dr = d[i] - r0;
    const dg = d[i + 1] - g0;
    const db = d[i + 2] - b0;
    const da = d[i + 3] - a0;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (match(p)) mask[p] = 1;
    return mask;
  }
  const stack = new Int32Array(w * h);
  let sp = 0;
  stack[sp++] = sy * w + sx;
  mask[sy * w + sx] = 1;
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0 && !mask[p - 1] && match(p - 1)) { mask[p - 1] = 1; stack[sp++] = p - 1; }
    if (x < w - 1 && !mask[p + 1] && match(p + 1)) { mask[p + 1] = 1; stack[sp++] = p + 1; }
    if (y > 0 && !mask[p - w] && match(p - w)) { mask[p - w] = 1; stack[sp++] = p - w; }
    if (y < h - 1 && !mask[p + w] && match(p + w)) { mask[p + w] = 1; stack[sp++] = p + w; }
  }
  return mask;
}

export function maskToCanvas(mask, w, h, color = [255, 255, 255]) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (mask[p]) {
      d[i] = color[0];
      d[i + 1] = color[1];
      d[i + 2] = color[2];
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
