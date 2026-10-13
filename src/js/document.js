// Document & layer model with snapshot-based undo history.
//
// Pixel data lives in canvases. History snapshots hold references to canvases;
// any canvas referenced by a snapshot is "frozen" and must be copied before it
// is modified (copy-on-write), which keeps undo cheap for non-pixel changes.

import { uid, createCanvas, cloneCanvas, deepClone, Emitter } from './util.js';
import { normalizeDevelop } from './develop.js';

const frozen = new WeakSet();

export const BLEND_MODES = [
  ['source-over', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'],
  ['color-burn', 'Color Burn'],
  ['hard-light', 'Hard Light'],
  ['soft-light', 'Soft Light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

export function defaultText() {
  return {
    text: 'Your text',
    font: 'Segoe UI',
    size: 72,
    color: '#ffffff',
    bold: false,
    italic: false,
    align: 'left',
    lineHeight: 1.2,
  };
}

let layerCounter = 0;

export class Layer {
  constructor(opts = {}) {
    this.id = opts.id || uid('layer');
    this.type = opts.type || 'raster';
    this.name = opts.name || (this.type === 'text' ? 'Text' : `Layer ${++layerCounter}`);
    this.visible = opts.visible ?? true;
    this.opacity = opts.opacity ?? 1;
    this.blend = opts.blend || 'source-over';
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.canvas = opts.canvas || null;
    this.mask = opts.mask || null;
    this.maskEnabled = opts.maskEnabled ?? true;
    this.develop = this.type === 'raster' ? normalizeDevelop(opts.develop) : null;
    this.text = this.type === 'text' ? { ...defaultText(), ...(opts.text || {}) } : null;
    this.linked = opts.linked || false; // develop synced to a library photo
    this.version = opts.version || 0;
    this.maskVersion = opts.maskVersion || 0;
    this._cache = null;
  }

  get width() {
    return this.canvas ? this.canvas.width : 0;
  }

  get height() {
    return this.canvas ? this.canvas.height : 0;
  }

  // Get a canvas that is safe to draw into (copy-on-write).
  editCanvas() {
    if (!this.canvas) return null;
    if (frozen.has(this.canvas)) this.canvas = cloneCanvas(this.canvas);
    this.version++;
    return this.canvas;
  }

  editMask() {
    if (!this.mask) return null;
    if (frozen.has(this.mask)) this.mask = cloneCanvas(this.mask);
    this.maskVersion++;
    return this.mask;
  }

  setCanvas(c) {
    this.canvas = c;
    this.version++;
  }

  setMask(c) {
    this.mask = c;
    this.maskVersion++;
  }

  touch() {
    this.version++;
  }

  snapshot() {
    if (this.canvas) frozen.add(this.canvas);
    if (this.mask) frozen.add(this.mask);
    return {
      id: this.id, type: this.type, name: this.name, visible: this.visible, opacity: this.opacity,
      blend: this.blend, x: this.x, y: this.y, canvas: this.canvas, mask: this.mask,
      maskEnabled: this.maskEnabled, develop: deepClone(this.develop), text: deepClone(this.text),
      linked: this.linked, version: this.version, maskVersion: this.maskVersion,
    };
  }

  static fromSnapshot(s) {
    const l = new Layer({ ...s, develop: deepClone(s.develop), text: deepClone(s.text) });
    l.version = s.version + 1; // ensure caches refresh
    return l;
  }
}

export class Doc extends Emitter {
  constructor({ width, height, name = 'Untitled' }) {
    super();
    this.id = uid('doc');
    this.name = name;
    this.width = width;
    this.height = height;
    this.layers = [];
    this.activeId = null;
    this.selection = null; // canvas (doc size) whose alpha is the selection
    this.lastSelection = null;
    this.filePath = null; // project path
    this.sourcePath = null; // original image path
    this.catalogId = null;
    this.exif = null;
    this.dirty = false;
    this.view = null; // {zoom, cx, cy}
    this.history = [];
    this.historyIndex = -1;
    this.structureVersion = 0;
  }

  get active() {
    return this.layers.find((l) => l.id === this.activeId) || this.layers[this.layers.length - 1] || null;
  }

  get activeIndex() {
    return this.layers.indexOf(this.active);
  }

  setActive(layer) {
    this.activeId = layer ? layer.id : null;
    this.emit('change', { type: 'active' });
  }

  addLayer(layer, index = null) {
    if (index == null) {
      const ai = this.activeIndex;
      index = ai >= 0 ? ai + 1 : this.layers.length;
    }
    this.layers.splice(index, 0, layer);
    this.activeId = layer.id;
    this.structureVersion++;
    return layer;
  }

  removeLayer(layer) {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (this.activeId === layer.id) {
      const next = this.layers[Math.min(i, this.layers.length - 1)] || this.layers[i - 1];
      this.activeId = next ? next.id : null;
    }
    this.structureVersion++;
  }

  moveLayer(layer, delta) {
    const i = this.layers.indexOf(layer);
    const j = Math.max(0, Math.min(this.layers.length - 1, i + delta));
    if (i < 0 || i === j) return false;
    this.layers.splice(i, 1);
    this.layers.splice(j, 0, layer);
    this.structureVersion++;
    return true;
  }

  setSelection(canvas) {
    if (this.selection) this.lastSelection = this.selection;
    this.selection = canvas;
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    this.emit('change', { type: 'selection' });
  }

  newRasterLayer(name) {
    const l = new Layer({ name, canvas: createCanvas(this.width, this.height) });
    return l;
  }

  snapshot(label) {
    if (this.selection) frozen.add(this.selection);
    return {
      label,
      width: this.width,
      height: this.height,
      activeId: this.activeId,
      selection: this.selection,
      layers: this.layers.map((l) => l.snapshot()),
    };
  }

  restore(snap) {
    this.width = snap.width;
    this.height = snap.height;
    this.layers = snap.layers.map((s) => Layer.fromSnapshot(s));
    this.activeId = snap.activeId;
    this.selection = snap.selection;
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    this.structureVersion++;
  }

  // ---- history ----

  initHistory(label = 'Open') {
    this.history = [this.snapshot(label)];
    this.historyIndex = 0;
  }

  commit(label) {
    this.history.length = this.historyIndex + 1;
    this.history.push(this.snapshot(label));
    this.historyIndex = this.history.length - 1;
    this.trimHistory();
    this.dirty = true;
    this.emit('change', { type: 'commit', label });
    this.emit('history');
  }

  trimHistory() {
    const MAX_STEPS = 50;
    const MAX_BYTES = 1.6e9;
    while (this.history.length > MAX_STEPS) {
      this.history.shift();
      this.historyIndex--;
    }
    // Estimate memory held by unique canvases in the history.
    const est = () => {
      const seen = new Set();
      let bytes = 0;
      for (const s of this.history) {
        const add = (c) => {
          if (c && !seen.has(c)) { seen.add(c); bytes += c.width * c.height * 4; }
        };
        add(s.selection);
        for (const l of s.layers) { add(l.canvas); add(l.mask); }
      }
      return bytes;
    };
    while (this.history.length > 2 && this.historyIndex > 1 && est() > MAX_BYTES) {
      this.history.shift();
      this.historyIndex--;
    }
  }

  canUndo() {
    return this.historyIndex > 0;
  }

  canRedo() {
    return this.historyIndex < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo()) return false;
    this.historyIndex--;
    this.restore(this.history[this.historyIndex]);
    this.dirty = true;
    this.emit('change', { type: 'undo' });
    this.emit('history');
    return true;
  }

  redo() {
    if (!this.canRedo()) return false;
    this.historyIndex++;
    this.restore(this.history[this.historyIndex]);
    this.dirty = true;
    this.emit('change', { type: 'redo' });
    this.emit('history');
    return true;
  }

  jumpTo(index) {
    if (index < 0 || index >= this.history.length || index === this.historyIndex) return;
    this.historyIndex = index;
    this.restore(this.history[index]);
    this.dirty = true;
    this.emit('change', { type: 'jump' });
    this.emit('history');
  }

  // Notify listeners that something visible changed (no history entry).
  changed(type = 'pixels') {
    this.emit('change', { type });
  }
}

export function isFrozen(canvas) {
  return frozen.has(canvas);
}

export function selectionBounds(sel) {
  if (!sel) return null;
  if (sel._bounds !== undefined) return sel._bounds;
  const g = sel.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = sel;
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  sel._bounds = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return sel._bounds;
}
