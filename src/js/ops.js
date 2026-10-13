// Document operations used by menus, panels, tools and shortcuts.

import { app } from './app.js';
import { Layer, selectionBounds } from './document.js';
import { createCanvas, cloneCanvas, deepClone, canvasToBlob, resizeCanvas, clamp } from './util.js';
import { layerImage, flatten, rasterizeTextLayer, layerBounds, measureText } from './render.js';
import {
  selectAll as selAll, invertSelection, featherSelection, growSelection, selectionForLayer, isSelectionEmpty,
} from './selection.js';
import { normalizeDevelop, autoTone as computeAutoTone, autoWhiteBalance, defaultDevelop } from './develop.js';
import { clipboardWriteImage, clipboardReadImage } from './platform.js';

export function doc() {
  return app.doc;
}

export function commit(label) {
  const d = app.doc;
  if (!d) return;
  d.commit(label);
  app.render();
}

function need(fn) {
  return (...args) => {
    if (!app.doc) return undefined;
    return fn(app.doc, ...args);
  };
}

function rasterActive(d, msg = 'Select a pixel layer first.') {
  const l = d.active;
  if (!l || l.type !== 'raster' || !l.canvas) {
    app.status(msg);
    return null;
  }
  return l;
}

// ---------------------------------------------------------------------------
// Layers

export const newLayer = need((d, name) => {
  const l = d.newRasterLayer(name);
  d.addLayer(l);
  app.maskEditing = false;
  commit('New Layer');
  return l;
});

export const duplicateLayer = need((d) => {
  const src = d.active;
  if (!src) return;
  const l = new Layer({
    type: src.type, name: src.name + ' copy', visible: src.visible, opacity: src.opacity, blend: src.blend,
    x: src.x, y: src.y, canvas: src.canvas ? cloneCanvas(src.canvas) : null, mask: src.mask ? cloneCanvas(src.mask) : null,
    maskEnabled: src.maskEnabled, develop: deepClone(src.develop), text: deepClone(src.text),
  });
  d.addLayer(l);
  commit('Duplicate Layer');
});

export const deleteLayer = need((d) => {
  const l = d.active;
  if (!l) return;
  if (d.layers.length <= 1) {
    app.status('A document needs at least one layer.');
    return;
  }
  d.removeLayer(l);
  commit('Delete Layer');
});

export const moveLayer = need((d, delta) => {
  if (d.moveLayer(d.active, delta)) commit(delta > 0 ? 'Move Layer Up' : 'Move Layer Down');
});

export const setLayerProp = need((d, layer, prop, value, label) => {
  layer[prop] = value;
  if (label) commit(label);
  else app.render();
});

function renderLayerInto(g, layer, opacity = true) {
  const img = layerImage(layer, 1);
  if (!img) return;
  g.globalAlpha = opacity ? layer.opacity : 1;
  g.globalCompositeOperation = layer.blend;
  g.drawImage(img, layer.x, layer.y);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

export const mergeDown = need((d) => {
  const i = d.activeIndex;
  if (i <= 0) {
    app.status('There is no layer below to merge into.');
    return;
  }
  const upper = d.layers[i];
  const lower = d.layers[i - 1];
  const c = createCanvas(d.width, d.height);
  const g = c.getContext('2d');
  renderLayerInto(g, lower, false);
  if (upper.visible) renderLayerInto(g, upper);
  const merged = new Layer({ name: lower.name, canvas: c, opacity: lower.opacity, blend: lower.blend, visible: lower.visible });
  d.layers.splice(i - 1, 2, merged);
  d.activeId = merged.id;
  d.structureVersion++;
  commit('Merge Down');
});

export const flattenImage = need((d) => {
  const c = flatten(d);
  const l = new Layer({ name: 'Background', canvas: c });
  d.layers = [l];
  d.activeId = l.id;
  d.structureVersion++;
  commit('Flatten Image');
});

export const mergeVisible = need((d) => {
  const c = flatten(d);
  const l = new Layer({ name: 'Merged', canvas: c });
  d.addLayer(l, d.layers.length);
  commit('Merge Visible');
});

export const layerViaCopy = need((d, cut = false) => {
  const l = rasterActive(d);
  if (!l) return;
  if (isSelectionEmpty(d.selection)) {
    if (!cut) duplicateLayer();
    return;
  }
  const sel = selectionForLayer(d, l);
  const c = cloneCanvas(l.canvas);
  const g = c.getContext('2d');
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(sel, 0, 0);
  if (cut) {
    const t = l.editCanvas().getContext('2d');
    t.globalCompositeOperation = 'destination-out';
    t.drawImage(sel, 0, 0);
    t.globalCompositeOperation = 'source-over';
  }
  const nl = new Layer({ name: cut ? 'Layer via Cut' : 'Layer via Copy', canvas: c, x: l.x, y: l.y, develop: deepClone(l.develop) });
  d.addLayer(nl);
  commit(cut ? 'Layer via Cut' : 'Layer via Copy');
});

export const addMask = need((d, fromSelection = true) => {
  const l = d.active;
  if (!l || l.type !== 'raster') { app.status('Masks can be added to pixel layers.'); return; }
  if (l.mask) { app.status('This layer already has a mask.'); return; }
  const m = createCanvas(l.width, l.height);
  const g = m.getContext('2d');
  if (fromSelection && !isSelectionEmpty(d.selection)) {
    g.drawImage(selectionForLayer(d, l), 0, 0);
  } else {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, m.width, m.height);
  }
  l.setMask(m);
  l.maskEnabled = true;
  app.maskEditing = true;
  commit('Add Layer Mask');
});

export const deleteMask = need((d, apply = false) => {
  const l = d.active;
  if (!l || !l.mask) return;
  if (apply) {
    const c = l.editCanvas();
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(l.mask, 0, 0);
    g.globalCompositeOperation = 'source-over';
  }
  l.setMask(null);
  app.maskEditing = false;
  commit(apply ? 'Apply Layer Mask' : 'Delete Layer Mask');
});

export const invertMask = need((d) => {
  const l = d.active;
  if (!l || !l.mask) return;
  const m = createCanvas(l.width, l.height);
  const g = m.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, m.width, m.height);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(l.mask, 0, 0);
  l.setMask(m);
  commit('Invert Mask');
});

export const rasterizeLayer = need((d) => {
  const l = d.active;
  if (!l || l.type !== 'text') return;
  rasterizeTextLayer(l);
  l.develop = normalizeDevelop(null);
  commit('Rasterize Type');
});

export const newTextLayer = need((d, x, y, text) => {
  const l = new Layer({ type: 'text', name: 'Text', x: Math.round(x), y: Math.round(y) });
  l.text.color = app.fg;
  l.text.size = Math.max(12, Math.round(Math.min(d.width, d.height) / 14));
  if (text) l.text.text = text;
  if (app.lastTextStyle) Object.assign(l.text, app.lastTextStyle, { color: app.fg });
  d.addLayer(l);
  commit('New Text Layer');
  return l;
});

// ---------------------------------------------------------------------------
// Selection

export const selectAll = need((d) => { d.setSelection(selAll(d)); commit('Select All'); });

export const deselect = need((d) => {
  if (!d.selection) return;
  d.setSelection(null);
  commit('Deselect');
});

export const reselect = need((d) => {
  if (!d.lastSelection) return;
  d.setSelection(d.lastSelection);
  commit('Reselect');
});

export const inverseSelection = need((d) => { d.setSelection(invertSelection(d)); commit('Inverse Selection'); });

export const feather = need((d, r) => {
  if (!d.selection) return;
  d.setSelection(featherSelection(d.selection, r));
  commit('Feather');
});

export const growShrink = need((d, px) => {
  if (!d.selection || !px) return;
  d.setSelection(growSelection(d.selection, px));
  commit(px > 0 ? 'Expand Selection' : 'Contract Selection');
});

export const selectLayerPixels = need((d) => {
  const l = d.active;
  if (!l) return;
  const c = createCanvas(d.width, d.height);
  const img = layerImage(l, 1);
  c.getContext('2d').drawImage(img, l.x, l.y);
  const g = c.getContext('2d');
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  d.setSelection(c);
  commit('Select Layer Pixels');
});

// ---------------------------------------------------------------------------
// Edit

export const clearSelection = need((d) => {
  if (isSelectionEmpty(d.selection)) {
    app.status('Make a selection first (or use Layer > Delete Layer).');
    return;
  }
  const l = d.active;
  if (!l || l.type !== 'raster') return;
  const target = app.maskEditing && l.mask ? l.editMask() : l.editCanvas();
  const g = target.getContext('2d');
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(selectionForLayer(d, l), 0, 0);
  g.globalCompositeOperation = 'source-over';
  commit('Clear');
});

export const fillWith = need((d, color, opacity = 1) => {
  const l = rasterActive(d);
  if (!l) return;
  const target = app.maskEditing && l.mask ? l.editMask() : l.editCanvas();
  const tmp = createCanvas(target.width, target.height);
  const tg = tmp.getContext('2d');
  tg.fillStyle = color;
  tg.fillRect(0, 0, tmp.width, tmp.height);
  if (!isSelectionEmpty(d.selection)) {
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(selectionForLayer(d, l), 0, 0);
  }
  const g = target.getContext('2d');
  g.globalAlpha = opacity;
  g.drawImage(tmp, 0, 0);
  g.globalAlpha = 1;
  commit('Fill');
});

async function putClipboard(canvas, x, y) {
  app.internalClipboard = { canvas, x, y };
  try {
    await clipboardWriteImage(await canvasToBlob(canvas, 'image/png'));
  } catch (e) {
    console.warn('clipboard', e);
  }
}

function regionCanvas(d, source, sx, sy) {
  // source: canvas positioned at (sx, sy) in doc coords
  const b = selectionBounds(d.selection) || { x: 0, y: 0, w: d.width, h: d.height };
  const c = createCanvas(b.w, b.h);
  const g = c.getContext('2d');
  g.drawImage(source, sx - b.x, sy - b.y);
  if (d.selection) {
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(d.selection, -b.x, -b.y);
  }
  return { canvas: c, x: b.x, y: b.y };
}

export const copy = need(async (d, merged = false) => {
  let r;
  if (merged) {
    r = regionCanvas(d, flatten(d), 0, 0);
  } else {
    const l = d.active;
    if (!l) return;
    r = regionCanvas(d, layerImage(l, 1), l.x, l.y);
  }
  await putClipboard(r.canvas, r.x, r.y);
  app.status(merged ? 'Copied merged image' : 'Copied');
});

export const cut = need(async (d) => {
  await copy(false);
  if (!isSelectionEmpty(d.selection)) clearSelection();
});

export async function paste() {
  let canvas = null;
  let pos = null;
  const internal = app.internalClipboard;
  const blob = await clipboardReadImage();
  if (blob) {
    try {
      const bmp = await createImageBitmap(blob);
      if (internal && internal.canvas.width === bmp.width && internal.canvas.height === bmp.height) {
        canvas = internal.canvas;
        pos = { x: internal.x, y: internal.y };
      } else {
        canvas = createCanvas(bmp.width, bmp.height);
        canvas.getContext('2d').drawImage(bmp, 0, 0);
      }
      bmp.close?.();
    } catch { /* ignore */ }
  } else if (internal) {
    canvas = internal.canvas;
    pos = { x: internal.x, y: internal.y };
  }
  if (!canvas) {
    app.status('The clipboard does not contain an image.');
    return;
  }
  if (!app.doc) {
    const { newDocumentFromCanvas } = await import('./commands.js');
    newDocumentFromCanvas(cloneCanvas(canvas), 'Pasted Image');
    return;
  }
  const d = app.doc;
  if (!pos) {
    const v = app.view ? app.view.view : { cx: d.width / 2, cy: d.height / 2 };
    pos = { x: Math.round(v.cx - canvas.width / 2), y: Math.round(v.cy - canvas.height / 2) };
  }
  const l = new Layer({ name: 'Pasted Layer', canvas: cloneCanvas(canvas), x: pos.x, y: pos.y });
  d.addLayer(l);
  app.maskEditing = false;
  commit('Paste');
}

// ---------------------------------------------------------------------------
// Image transforms

function xform(src, w, h, setup) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  setup(g);
  g.drawImage(src, 0, 0);
  return c;
}

// mapLayer(layer) -> { canvas, mask, x, y } or mutate text layers; returns new doc size
function transformAll(d, newW, newH, mapLayer, label, keepSelection = false) {
  for (const l of d.layers) {
    if (l.type === 'text') {
      if (mapLayer.textOK) { mapLayer.text(l); continue; }
      rasterizeTextLayer(l);
      l.develop = normalizeDevelop(null);
    }
    const r = mapLayer(l);
    l.setCanvas(r.canvas);
    if (l.mask) l.setMask(r.mask);
    l.x = r.x;
    l.y = r.y;
  }
  d.width = newW;
  d.height = newH;
  if (!keepSelection) d.setSelection(null);
  d.view = null;
  d.structureVersion++;
  commit(label);
}

export const rotate = need((d, deg) => {
  const W = d.width;
  const H = d.height;
  if (deg === 180) {
    transformAll(d, W, H, (l) => {
      const f = (c) => xform(c, c.width, c.height, (g) => { g.translate(c.width, c.height); g.rotate(Math.PI); });
      return { canvas: f(l.canvas), mask: l.mask && f(l.mask), x: W - l.x - l.width, y: H - l.y - l.height };
    }, 'Rotate 180°');
    return;
  }
  const cw = deg === 90;
  transformAll(d, H, W, (l) => {
    const f = (c) => xform(c, c.height, c.width, (g) => {
      if (cw) { g.translate(c.height, 0); g.rotate(Math.PI / 2); } else { g.translate(0, c.width); g.rotate(-Math.PI / 2); }
    });
    const x = cw ? H - l.y - l.height : l.y;
    const y = cw ? l.x : W - l.x - l.width;
    return { canvas: f(l.canvas), mask: l.mask && f(l.mask), x, y };
  }, cw ? 'Rotate 90° CW' : 'Rotate 90° CCW');
});

export const flip = need((d, horizontal) => {
  const W = d.width;
  const H = d.height;
  transformAll(d, W, H, (l) => {
    const f = (c) => xform(c, c.width, c.height, (g) => {
      if (horizontal) { g.translate(c.width, 0); g.scale(-1, 1); } else { g.translate(0, c.height); g.scale(1, -1); }
    });
    return {
      canvas: f(l.canvas), mask: l.mask && f(l.mask),
      x: horizontal ? W - l.x - l.width : l.x,
      y: horizontal ? l.y : H - l.y - l.height,
    };
  }, horizontal ? 'Flip Horizontal' : 'Flip Vertical');
});

export const resizeImage = need((d, newW, newH) => {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  const sx = newW / d.width;
  const sy = newH / d.height;
  const fn = (l) => {
    const w = Math.max(1, Math.round(l.width * sx));
    const h = Math.max(1, Math.round(l.height * sy));
    return { canvas: resizeCanvas(l.canvas, w, h), mask: l.mask && resizeCanvas(l.mask, w, h), x: Math.round(l.x * sx), y: Math.round(l.y * sy) };
  };
  fn.textOK = true;
  fn.text = (l) => {
    l.x = Math.round(l.x * sx);
    l.y = Math.round(l.y * sy);
    l.text.size = Math.max(1, Math.round(l.text.size * sy));
  };
  transformAll(d, newW, newH, fn, 'Image Size');
});

// anchor: [ax, ay] each in {0, 0.5, 1}
export const resizeCanvasOp = need((d, newW, newH, anchor = [0.5, 0.5], fill = null) => {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  const dx = Math.round((newW - d.width) * anchor[0]);
  const dy = Math.round((newH - d.height) * anchor[1]);
  const fn = (l) => ({ canvas: l.canvas, mask: l.mask, x: l.x + dx, y: l.y + dy });
  fn.textOK = true;
  fn.text = (l) => { l.x += dx; l.y += dy; };
  transformAll(d, newW, newH, fn, 'Canvas Size');
  if (fill && d.layers.length) {
    const base = d.layers[0];
    if (base.type === 'raster') {
      const c = createCanvas(newW, newH);
      const g = c.getContext('2d');
      g.fillStyle = fill;
      g.fillRect(0, 0, newW, newH);
      g.drawImage(base.canvas, base.x, base.y);
      if (base.mask) {
        const m = createCanvas(newW, newH);
        const mg = m.getContext('2d');
        mg.fillStyle = '#fff';
        mg.fillRect(0, 0, newW, newH);
        mg.clearRect(base.x, base.y, base.width, base.height);
        mg.drawImage(base.mask, base.x, base.y);
        base.setMask(m);
      }
      base.setCanvas(c);
      base.x = 0;
      base.y = 0;
      d.history[d.historyIndex] = d.snapshot('Canvas Size');
      app.render();
    }
  }
});

// rect in doc coords (rotated by angle degrees around its centre)
export const cropTo = need((d, rect, angle = 0) => {
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  if (!angle) {
    const rx = Math.round(rect.x);
    const ry = Math.round(rect.y);
    const fn = (l) => {
      // keep only the part of the layer inside the crop
      const x0 = Math.max(l.x, rx);
      const y0 = Math.max(l.y, ry);
      const x1 = Math.min(l.x + l.width, rx + w);
      const y1 = Math.min(l.y + l.height, ry + h);
      if (x1 <= x0 || y1 <= y0) {
        return { canvas: createCanvas(1, 1), mask: l.mask && createCanvas(1, 1), x: 0, y: 0 };
      }
      const cut = (c) => {
        const o = createCanvas(x1 - x0, y1 - y0);
        o.getContext('2d').drawImage(c, l.x - x0, l.y - y0);
        return o;
      };
      return { canvas: cut(l.canvas), mask: l.mask && cut(l.mask), x: x0 - rx, y: y0 - ry };
    };
    fn.textOK = true;
    fn.text = (l) => { l.x -= rx; l.y -= ry; };
    transformAll(d, w, h, fn, 'Crop');
    return;
  }
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const a = (angle * Math.PI) / 180;
  transformAll(d, w, h, (l) => {
    const f = (c) => {
      const o = createCanvas(w, h);
      const g = o.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.translate(w / 2, h / 2);
      g.rotate(-a);
      g.translate(-cx, -cy);
      g.drawImage(c, l.x, l.y);
      return o;
    };
    return { canvas: f(l.canvas), mask: l.mask && f(l.mask), x: 0, y: 0 };
  }, 'Crop');
});

export const cropToSelection = need((d) => {
  const b = selectionBounds(d.selection);
  if (!b) { app.status('Make a selection first.'); return; }
  cropTo(b, 0);
});

export const trimTransparent = need((d) => {
  const c = flatten(d);
  const tmp = createCanvas(d.width, d.height);
  tmp.getContext('2d').drawImage(c, 0, 0);
  const b = selectionBounds(tmp);
  if (!b) return;
  cropTo(b, 0);
});

// Free transform: apply matrix to the active layer.
// m = { a, b, c, d, e, f } maps layer-local pixel coords -> doc coords.
export const applyLayerTransform = need((d, layer, m, label = 'Free Transform') => {
  if (layer.type === 'text') {
    rasterizeTextLayer(layer);
    layer.develop = normalizeDevelop(null);
  }
  const w0 = layer.width;
  const h0 = layer.height;
  const pts = [[0, 0], [w0, 0], [0, h0], [w0, h0]].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  const minX = Math.floor(Math.min(...pts.map((p) => p[0])));
  const minY = Math.floor(Math.min(...pts.map((p) => p[1])));
  const maxX = Math.ceil(Math.max(...pts.map((p) => p[0])));
  const maxY = Math.ceil(Math.max(...pts.map((p) => p[1])));
  const W = clamp(maxX - minX, 1, 20000);
  const H = clamp(maxY - minY, 1, 20000);
  const f = (c) => {
    const o = createCanvas(W, H);
    const g = o.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.setTransform(m.a, m.b, m.c, m.d, m.e - minX, m.f - minY);
    g.drawImage(c, 0, 0);
    return o;
  };
  layer.setCanvas(f(layer.canvas));
  if (layer.mask) layer.setMask(f(layer.mask));
  layer.x = minX;
  layer.y = minY;
  commit(label);
});

// ---------------------------------------------------------------------------
// Develop

export function activeDevelopLayer() {
  const d = app.doc;
  if (!d) return null;
  const l = d.active;
  if (l && l.type === 'raster') return l;
  return d.layers.find((x) => x.type === 'raster') || null;
}

export function setDevelop(settings, label = 'Develop') {
  const l = activeDevelopLayer();
  if (!l) return;
  l.develop = normalizeDevelop(settings);
  commit(label);
  app.emit('develop-changed');
}

export function autoTone() {
  const l = activeDevelopLayer();
  if (!l) return;
  setDevelop(computeAutoTone(l.canvas, l.develop), 'Auto Tone');
}

export function autoWB() {
  const l = activeDevelopLayer();
  if (!l) return;
  const wb = autoWhiteBalance(l.canvas);
  setDevelop({ ...l.develop, ...wb }, 'Auto White Balance');
}

export function resetDevelop() {
  setDevelop(defaultDevelop(), 'Reset Develop');
}

export function textLayerBounds(l) {
  return l.type === 'text' ? layerBounds(l) : null;
}

export { measureText };
