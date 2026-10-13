// Painting tools: brush, eraser, clone stamp, spot healing, paint bucket, gradient.

import { app } from '../app.js';
import { commit } from '../ops.js';
import { Stroke } from '../brush.js';
import { healArea } from '../heal.js';
import { selectionForLayer, floodMask, maskToCanvas } from '../selection.js';
import { createCanvas, cloneCanvas, hexToRgb, el } from '../util.js';
import { slider, checkField, numField, segmented } from '../ui/widgets.js';

function paintTarget(d, { allowMask = true } = {}) {
  const l = d.active;
  if (!l) return null;
  if (l.type !== 'raster') {
    app.status('This is a text layer. Use Layer › Rasterize Type to paint on it.');
    return null;
  }
  if (!l.visible) {
    app.status('The active layer is hidden.');
    return null;
  }
  if (allowMask && app.maskEditing && l.mask) return { layer: l, canvas: l.editMask(), isMask: true };
  return { layer: l, canvas: l.editCanvas(), isMask: false };
}

function isLight(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b >= 128;
}

function pressureOf(e) {
  return e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 1;
}

function brushOptions(bar, { flow = true, extra } = {}) {
  const b = app.brush;
  const sizeEl = slider({ label: 'Size', min: 1, max: 1000, step: 1, value: b.size, def: 40, format: (v) => Math.round(v) + ' px', onInput: (v) => { b.size = v; app.view.requestFrame(); } });
  const hardEl = slider({ label: 'Hardness', min: 0, max: 100, step: 1, value: Math.round(b.hardness * 100), def: 75, format: (v) => Math.round(v) + '%', onInput: (v) => { b.hardness = v / 100; } });
  const opEl = slider({ label: 'Opacity', min: 1, max: 100, step: 1, value: Math.round(b.opacity * 100), def: 100, format: (v) => Math.round(v) + '%', onInput: (v) => { b.opacity = v / 100; } });
  bar.append(sizeEl, hardEl, opEl);
  if (flow) {
    bar.append(slider({ label: 'Flow', min: 1, max: 100, step: 1, value: Math.round(b.flow * 100), def: 100, format: (v) => Math.round(v) + '%', onInput: (v) => { b.flow = v / 100; } }));
  }
  bar.append(checkField({ label: 'Pen pressure', value: b.pressure, title: 'Pen tablet pressure controls brush size', onChange: (v) => { b.pressure = v; } }));
  if (extra) extra(bar);
  // keep sliders in sync when [ ] shortcuts change the brush
  const off = app.on('brush', () => { sizeEl.set(b.size); hardEl.set(Math.round(b.hardness * 100)); opEl.set(Math.round(b.opacity * 100)); });
  bar.cleanup = off;
}

function makePainter({ id, name, key, icon, mode }) {
  return {
    id, name, key, icon, cursor: 'none', modules: ['edit'],
    options(bar) {
      brushOptions(bar);
      if (mode === 'paint') bar.append(el('span', { class: 'hint' }, 'Alt+click picks a color'));
    },
    onDown(e, p, view) {
      if (mode === 'paint' && e.altKey) {
        const c = view.sampleColor(p.x, p.y);
        if (c) { app.fg = '#' + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join(''); app.emit('colors'); }
        return;
      }
      const d = app.doc;
      const t = paintTarget(d);
      if (!t) return;
      const b = app.brush;
      let m = mode;
      let color = e.button === 2 ? app.bg : app.fg;
      if (t.isMask) {
        const reveal = mode === 'erase' ? !isLight(color) : isLight(color);
        m = reveal ? 'mask-reveal' : 'mask-hide';
        color = '#ffffff';
      }
      const l = t.layer;
      this.stroke = new Stroke({
        target: t.canvas, mode: m, color, size: b.size, hardness: b.hardness, opacity: b.opacity, flow: b.flow,
        pressure: b.pressure, selection: selectionForLayer(d, l),
        onUpdate: () => {
          if (t.isMask) l.maskVersion++; else l.version++;
          app.render();
        },
      });
      this.layer = l;
      this.stroke.begin({ x: p.x - l.x, y: p.y - l.y }, pressureOf(e));
    },
    onMove(e, p) {
      if (!this.stroke) return;
      this.stroke.add({ x: p.x - this.layer.x, y: p.y - this.layer.y }, pressureOf(e));
    },
    onUp() {
      if (!this.stroke) return;
      this.stroke = null;
      commit(name);
    },
    drawOverlay(g, view) {
      view.drawBrushCursor(g, app.brush.size);
    },
  };
}

export const brushTool = makePainter({ id: 'brush', name: 'Brush', key: 'B', icon: 'brush', mode: 'paint' });
export const eraserTool = makePainter({ id: 'eraser', name: 'Eraser', key: 'E', icon: 'eraser', mode: 'erase' });

export const cloneTool = {
  id: 'clone', name: 'Clone Stamp', key: 'S', icon: 'clone', cursor: 'none', modules: ['edit'],
  source: null,
  aligned: true,
  offset: null,
  options(bar) {
    brushOptions(bar, {
      extra: (b) => b.append(checkField({ label: 'Aligned', value: this.aligned, onChange: (v) => { this.aligned = v; this.offset = null; } })),
    });
    bar.append(el('span', { class: 'hint' }, 'Alt+click to set the source point, then paint'));
  },
  onDown(e, p) {
    const d = app.doc;
    if (e.altKey) {
      this.source = { x: p.x, y: p.y };
      this.offset = null;
      app.status('Clone source set');
      return;
    }
    if (!this.source) {
      app.status('Alt+click to set a clone source first.');
      return;
    }
    const t = paintTarget(d, { allowMask: false });
    if (!t) return;
    if (!this.aligned || !this.offset) this.offset = { x: this.source.x - p.x, y: this.source.y - p.y };
    const b = app.brush;
    const l = t.layer;
    this.layer = l;
    this.stroke = new Stroke({
      target: t.canvas, mode: 'clone', size: b.size, hardness: b.hardness, opacity: b.opacity, flow: b.flow,
      pressure: b.pressure, selection: selectionForLayer(d, l), cloneOffset: this.offset,
      onUpdate: () => { l.version++; app.render(); },
    });
    this.stroke.cloneSource = this.stroke.base;
    this.cur = p;
    this.stroke.begin({ x: p.x - l.x, y: p.y - l.y }, pressureOf(e));
  },
  onMove(e, p) {
    this.cur = p;
    if (!this.stroke) return;
    this.stroke.add({ x: p.x - this.layer.x, y: p.y - this.layer.y }, pressureOf(e));
  },
  onHover(e, p) { this.cur = p; },
  onUp() {
    if (!this.stroke) return;
    this.stroke = null;
    commit('Clone Stamp');
  },
  drawOverlay(g, view) {
    view.drawBrushCursor(g, app.brush.size);
    let src = null;
    if (this.stroke && this.offset && this.cur) src = { x: this.cur.x + this.offset.x, y: this.cur.y + this.offset.y };
    else if (this.source && !this.offset) src = this.source;
    else if (this.source && this.offset && this.cur && this.aligned) src = { x: this.cur.x + this.offset.x, y: this.cur.y + this.offset.y };
    if (src) {
      const s = view.docToScreen(src.x, src.y);
      g.strokeStyle = '#fff';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(s.x - 8, s.y); g.lineTo(s.x + 8, s.y);
      g.moveTo(s.x, s.y - 8); g.lineTo(s.x, s.y + 8);
      g.stroke();
      g.beginPath();
      g.arc(s.x, s.y, (app.brush.size / 2) * view.view.zoom, 0, Math.PI * 2);
      g.setLineDash([3, 3]);
      g.stroke();
    }
  },
};

export const healTool = {
  id: 'heal', name: 'Spot Healing Brush', key: 'J', icon: 'heal', cursor: 'none', modules: ['develop', 'edit'],
  options(bar) {
    const b = app.brush;
    const sizeEl = slider({ label: 'Size', min: 2, max: 600, step: 1, value: b.size, def: 40, format: (v) => Math.round(v) + ' px', onInput: (v) => { b.size = v; app.view.requestFrame(); } });
    bar.append(sizeEl, el('span', { class: 'hint' }, 'Paint over spots, dust or blemishes to remove them · [ and ] change size'));
    bar.cleanup = app.on('brush', () => sizeEl.set(b.size));
  },
  onDown(e, p) {
    const d = app.doc;
    const l = d.active && d.active.type === 'raster' ? d.active : d.layers.find((x) => x.type === 'raster');
    if (!l) return;
    if (l !== d.active) d.setActive(l);
    this.layer = l;
    const b = app.brush;
    this.stroke = new Stroke({ target: l.canvas, mode: 'collect', size: b.size, hardness: 0.6, flow: 1, onUpdate: () => app.view.requestFrame() });
    this.stroke.begin({ x: p.x - l.x, y: p.y - l.y });
  },
  onMove(e, p) {
    if (!this.stroke) return;
    this.stroke.add({ x: p.x - this.layer.x, y: p.y - this.layer.y });
  },
  onUp() {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    const l = this.layer;
    if (!s.bounds) return;
    const target = l.editCanvas();
    if (app.doc.selection) {
      const sel = selectionForLayer(app.doc, l);
      const g = s.buffer.getContext('2d');
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(sel, 0, 0);
    }
    healArea(target, s.buffer, s.bounds, app.brush.size);
    commit('Spot Healing');
  },
  drawOverlay(g, view) {
    if (this.stroke && this.layer) {
      const v = view.view;
      const tl = view.docToScreen(this.layer.x, this.layer.y);
      g.globalAlpha = 0.45;
      g.imageSmoothingEnabled = true;
      g.drawImage(this.stroke.buffer, tl.x, tl.y, this.layer.width * v.zoom, this.layer.height * v.zoom);
      g.globalAlpha = 1;
    }
    view.drawBrushCursor(g, app.brush.size);
  },
};

export const bucketTool = {
  id: 'bucket', name: 'Paint Bucket', key: 'G', icon: 'bucket', cursor: 'crosshair', modules: ['edit'], group: 'fill',
  tolerance: 32,
  contiguous: true,
  options(bar) {
    bar.append(
      numField({ label: 'Tolerance', value: this.tolerance, min: 0, max: 255, onChange: (v) => { this.tolerance = v; } }),
      checkField({ label: 'Contiguous', value: this.contiguous, onChange: (v) => { this.contiguous = v; } }),
      slider({ label: 'Opacity', min: 1, max: 100, value: Math.round(app.brush.opacity * 100), def: 100, format: (v) => Math.round(v) + '%', onInput: (v) => { app.brush.opacity = v / 100; } }),
    );
  },
  onDown(e, p) {
    const d = app.doc;
    const t = paintTarget(d);
    if (!t) return;
    const l = t.layer;
    const c = t.canvas;
    const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
    const mask = floodMask(data, p.x - l.x, p.y - l.y, this.tolerance, this.contiguous);
    const color = e.button === 2 ? app.bg : app.fg;
    let fillColor = hexToRgb(color);
    if (t.isMask) fillColor = { r: 255, g: 255, b: 255 };
    const fill = maskToCanvas(mask, c.width, c.height, [fillColor.r, fillColor.g, fillColor.b]);
    const sel = selectionForLayer(d, l);
    if (sel) {
      const fg = fill.getContext('2d');
      fg.globalCompositeOperation = 'destination-in';
      fg.drawImage(sel, 0, 0);
    }
    const g = c.getContext('2d');
    g.globalAlpha = app.brush.opacity;
    g.globalCompositeOperation = t.isMask && !isLight(color) ? 'destination-out' : 'source-over';
    g.drawImage(fill, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    commit('Paint Bucket');
  },
};

export const gradientTool = {
  id: 'gradient', name: 'Gradient', key: 'G', icon: 'gradient', cursor: 'crosshair', modules: ['edit'], group: 'fill',
  kind: 'linear',
  toTransparent: false,
  options(bar) {
    bar.append(
      segmented({ options: [['linear', 'Linear'], ['radial', 'Radial']], value: this.kind, onChange: (v) => { this.kind = v; } }),
      checkField({ label: 'Foreground to transparent', value: this.toTransparent, onChange: (v) => { this.toTransparent = v; } }),
      slider({ label: 'Opacity', min: 1, max: 100, value: Math.round(app.brush.opacity * 100), def: 100, format: (v) => Math.round(v) + '%', onInput: (v) => { app.brush.opacity = v / 100; } }),
      el('span', { class: 'hint' }, 'Drag across the image · Works on layer masks too'),
    );
  },
  onDown(e, p) {
    const d = app.doc;
    const t = paintTarget(d);
    if (!t) return;
    this.t = t;
    this.base = cloneCanvas(t.canvas);
    this.p0 = p;
    this.p1 = p;
  },
  render() {
    const { t, base, p0, p1 } = this;
    const l = t.layer;
    const out = cloneCanvas(base);
    const tmp = createCanvas(out.width, out.height);
    const g = tmp.getContext('2d');
    const x0 = p0.x - l.x;
    const y0 = p0.y - l.y;
    const x1 = p1.x - l.x;
    const y1 = p1.y - l.y;
    const grad = this.kind === 'radial'
      ? g.createRadialGradient(x0, y0, 0, x0, y0, Math.max(1, Math.hypot(x1 - x0, y1 - y0)))
      : g.createLinearGradient(x0, y0, x1, y1);
    const toAlpha = (hex, a = 1) => {
      const { r, g: gg, b } = hexToRgb(hex);
      if (t.isMask) {
        const L = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
        return `rgba(255,255,255,${(L * a).toFixed(3)})`;
      }
      return `rgba(${r},${gg},${b},${a})`;
    };
    grad.addColorStop(0, toAlpha(app.fg));
    grad.addColorStop(1, this.toTransparent ? toAlpha(app.fg, 0) : toAlpha(app.bg));
    g.fillStyle = grad;
    g.fillRect(0, 0, tmp.width, tmp.height);
    const sel = selectionForLayer(app.doc, l);
    if (sel) {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(sel, 0, 0);
    }
    const og = out.getContext('2d');
    if (t.isMask && !this.toTransparent) {
      // masks: the gradient replaces the mask inside the selection
      if (sel) {
        og.globalCompositeOperation = 'destination-out';
        og.drawImage(sel, 0, 0);
      } else {
        og.clearRect(0, 0, out.width, out.height);
      }
      og.globalCompositeOperation = 'source-over';
    }
    og.globalAlpha = app.brush.opacity;
    og.drawImage(tmp, 0, 0);
    return out;
  },
  onMove(e, p) {
    if (!this.t) return;
    this.p1 = p;
    const out = this.render();
    if (this.t.isMask) {
      this.t.layer.mask = out;
      this.t.layer.maskVersion++;
    } else {
      this.t.layer.canvas = out;
      this.t.layer.version++;
    }
    app.render();
  },
  onUp() {
    if (!this.t) return;
    const moved = Math.hypot(this.p1.x - this.p0.x, this.p1.y - this.p0.y) > 1;
    if (!moved) {
      // restore
      if (this.t.isMask) this.t.layer.setMask(this.base); else this.t.layer.setCanvas(this.base);
      this.t = null;
      app.render();
      return;
    }
    this.t = null;
    commit('Gradient');
  },
  drawOverlay(g, view) {
    if (!this.t) return;
    const a = view.docToScreen(this.p0.x, this.p0.y);
    const b = view.docToScreen(this.p1.x, this.p1.y);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    for (const q of [a, b]) {
      g.beginPath();
      g.arc(q.x, q.y, 4, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.strokeStyle = '#000';
      g.stroke();
    }
  },
};

