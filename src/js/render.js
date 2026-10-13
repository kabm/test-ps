// Compositing: turns a Doc into pixels at a given scale, caching per-layer results.

import { createCanvas, resizeCanvas } from './util.js';
import { renderDevelop, developKey, isIdentityDevelop } from './develop.js';

// ---- text layers ----

export function textFont(t, scale = 1) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${Math.max(1, t.size * scale)}px "${t.font}", "Segoe UI", Arial, sans-serif`;
}

export function measureText(t) {
  const c = measureText._c || (measureText._c = createCanvas(4, 4));
  const g = c.getContext('2d');
  g.font = textFont(t);
  const lines = String(t.text).split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, g.measureText(line || ' ').width);
  const lh = t.size * t.lineHeight;
  return { w: Math.ceil(w) + 4, h: Math.ceil(lh * lines.length + t.size * 0.3), lines, lh };
}

export function renderTextCanvas(t, scale = 1) {
  const m = measureText(t);
  const c = createCanvas(Math.max(1, m.w * scale), Math.max(1, m.h * scale));
  const g = c.getContext('2d');
  g.font = textFont(t, scale);
  g.fillStyle = t.color;
  g.textBaseline = 'top';
  g.textAlign = t.align;
  const ax = t.align === 'center' ? c.width / 2 : t.align === 'right' ? c.width - 2 * scale : 2 * scale;
  m.lines.forEach((line, i) => {
    g.fillText(line, ax, (i * m.lh + t.size * 0.08) * scale);
  });
  return c;
}

export function rasterizeTextLayer(layer) {
  if (layer.type !== 'text') return;
  layer.canvas = renderTextCanvas(layer.text, 1);
  layer.type = 'raster';
  layer.text = null;
  layer.develop = layer.develop || null;
  layer.version++;
}

// ---- per-layer pipeline ----

function scaledSource(layer, s) {
  const c = layer._scaled;
  if (c && c.src === layer.canvas && c.version === layer.version && c.s === s) return c.canvas;
  const canvas = s === 1 ? layer.canvas : resizeCanvas(layer.canvas, layer.canvas.width * s, layer.canvas.height * s);
  layer._scaled = { src: layer.canvas, version: layer.version, s, canvas };
  return canvas;
}

function scaledMask(layer, s) {
  const c = layer._scaledMask;
  if (c && c.src === layer.mask && c.version === layer.maskVersion && c.s === s) return c.canvas;
  const canvas = s === 1 ? layer.mask : resizeCanvas(layer.mask, layer.mask.width * s, layer.mask.height * s);
  layer._scaledMask = { src: layer.mask, version: layer.maskVersion, s, canvas };
  return canvas;
}

// Returns the developed (and masked) pixels of a layer at scale s.
export function layerImage(layer, s, { before = false, previewDevelop = null, refW, refH } = {}) {
  if (layer.type === 'text') {
    const key = JSON.stringify(layer.text) + '|' + s;
    if (layer._textCache && layer._textCache.key === key) return layer._textCache.canvas;
    const canvas = renderTextCanvas(layer.text, s);
    layer._textCache = { key, canvas };
    return canvas;
  }
  if (!layer.canvas) return null;
  const settings = before ? null : previewDevelop || layer.develop;
  const dkey = developKey(settings);
  const useMask = !!(layer.mask && layer.maskEnabled);
  const key = `${layer.version}|${s}|${dkey}|${useMask ? layer.maskVersion : 'nomask'}`;
  const c = layer._cache;
  if (c && c.key === key && c.src === layer.canvas && c.mask === layer.mask) return c.canvas;

  let img = scaledSource(layer, s);
  if (!isIdentityDevelop(settings)) {
    try {
      const prev = c && c.devCanvas;
      img = renderDevelop(img, settings, { refW: refW || layer.canvas.width, refH: refH || layer.canvas.height, target: prev });
    } catch (err) {
      console.error(err);
    }
  }
  const devCanvas = img !== layer.canvas && img !== (layer._scaled && layer._scaled.canvas) ? img : null;
  if (useMask) {
    const m = scaledMask(layer, s);
    const out = createCanvas(img.width, img.height);
    const g = out.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(m, 0, 0, out.width, out.height);
    img = out;
  }
  layer._cache = { key, src: layer.canvas, mask: layer.mask, canvas: img, devCanvas };
  return img;
}

// ---- compositor ----

export class Compositor {
  constructor() {
    this.canvas = null;
    this.key = null;
  }

  // Render the document at scale s. Returns a canvas of size (w*s, h*s).
  render(doc, s, opts = {}) {
    const w = Math.max(1, Math.round(doc.width * s));
    const h = Math.max(1, Math.round(doc.height * s));
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = createCanvas(w, h);
    }
    return compositeInto(this.canvas, doc, s, opts);
  }
}

export function compositeInto(canvas, doc, s, { before = false, previews = null, hidden = null, background = null } = {}) {
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  for (const layer of doc.layers) {
    if (!layer.visible || (hidden && hidden.has(layer))) continue;
    const pv = previews && previews.get(layer);
    let img;
    if (pv && pv.canvas) {
      // Temporary pixel preview (filters): run through the normal pipeline using a stand-in layer.
      const tmp = pv.layerProxy || (pv.layerProxy = Object.create(layer));
      tmp.canvas = pv.canvas;
      tmp.version = pv.version || 0;
      tmp._cache = pv._cache;
      tmp._scaled = pv._scaled;
      img = layerImage(tmp, s, { before, refW: layer.width, refH: layer.height });
      pv._cache = tmp._cache;
      pv._scaled = tmp._scaled;
    } else {
      img = layerImage(layer, s, { before, previewDevelop: pv && pv.develop, refW: layer.width, refH: layer.height });
    }
    if (!img) continue;
    g.globalAlpha = layer.opacity;
    g.globalCompositeOperation = layer.blend;
    g.drawImage(img, layer.x * s, layer.y * s);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return canvas;
}

// Full resolution flattened image (for export, copy merged, eyedropper, etc.)
export function flatten(doc, opts = {}) {
  const c = createCanvas(doc.width, doc.height);
  return compositeInto(c, doc, 1, opts);
}

// Bounds of a layer in document coordinates.
export function layerBounds(layer) {
  if (layer.type === 'text') {
    const m = measureText(layer.text);
    return { x: layer.x, y: layer.y, w: m.w, h: m.h };
  }
  return { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
}
