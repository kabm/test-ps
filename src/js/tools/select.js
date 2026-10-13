// Selection tools: rectangular & elliptical marquee, lasso, magic wand.

import { app } from '../app.js';
import { commit } from '../ops.js';
import { shapeSelection, combineSelection, floodMask, maskToCanvas, featherSelection } from '../selection.js';
import { flatten, layerImage } from '../render.js';
import { createCanvas, el } from '../util.js';
import { segmented, numField, checkField } from '../ui/widgets.js';

const selState = { mode: 'replace', feather: 0 };

function modeFrom(e) {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return selState.mode;
}

function modeOptions(bar, withFeather = true) {
  bar.append(segmented({
    options: [['replace', 'New', 'New selection'], ['add', 'Add', 'Add to selection (Shift)'], ['subtract', 'Subtract', 'Subtract from selection (Alt)'], ['intersect', 'Intersect', 'Intersect (Shift+Alt)']],
    value: selState.mode,
    onChange: (v) => { selState.mode = v; },
  }));
  if (withFeather) {
    bar.append(numField({ label: 'Feather', value: selState.feather, min: 0, max: 250, onChange: (v) => { selState.feather = v; }, suffix: 'px' }));
  }
}

function applyShape(label, mode, drawPath) {
  const d = app.doc;
  const shape = shapeSelection(d, drawPath, selState.feather);
  const sel = combineSelection(d, shape, mode);
  d.setSelection(sel);
  commit(label);
}

function makeMarquee(id, name, key, iconName, ellipse) {
  return {
    id, name, key, icon: iconName, cursor: 'crosshair', modules: ['edit'], group: 'marquee',
    options(bar) {
      modeOptions(bar);
      bar.append(el('span', { class: 'hint' }, 'Shift = add · Alt = subtract · hold Shift while dragging for a square'));
    },
    onDown(e, p) {
      this.drag = { p0: p, p1: p, mode: modeFrom(e), shiftAtStart: e.shiftKey, altAtStart: e.altKey };
    },
    rect(e) {
      const { p0, p1, shiftAtStart, altAtStart } = this.drag;
      let w = p1.x - p0.x;
      let h = p1.y - p0.y;
      if (e && e.shiftKey && !shiftAtStart) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      if (e && e.altKey && !altAtStart) return { x: p0.x - w, y: p0.y - h, w: w * 2, h: h * 2 };
      return { x: p0.x, y: p0.y, w, h };
    },
    onMove(e, p) {
      if (!this.drag) return;
      this.drag.p1 = p;
      this.drag.r = this.rect(e);
    },
    onUp(e) {
      if (!this.drag) return;
      const r = this.drag.r;
      const mode = this.drag.mode;
      this.drag = null;
      if (!r || Math.abs(r.w) < 2 || Math.abs(r.h) < 2) {
        if (mode === 'replace' && app.doc.selection) { app.doc.setSelection(null); commit('Deselect'); }
        return;
      }
      const x = Math.min(r.x, r.x + r.w);
      const y = Math.min(r.y, r.y + r.h);
      const w = Math.abs(r.w);
      const h = Math.abs(r.h);
      applyShape(ellipse ? 'Elliptical Marquee' : 'Rectangular Marquee', mode, (g) => {
        if (ellipse) g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        else g.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      });
    },
    drawOverlay(g, view) {
      if (!this.drag || !this.drag.r) return;
      const r = this.drag.r;
      const a = view.docToScreen(r.x, r.y);
      const b = view.docToScreen(r.x + r.w, r.y + r.h);
      g.beginPath();
      if (ellipse) g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      else g.rect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
      g.strokeStyle = '#000';
      g.stroke();
      g.setLineDash([4, 4]);
      g.strokeStyle = '#fff';
      g.stroke();
    },
  };
}

export const marqueeTool = makeMarquee('marquee', 'Rectangular Marquee', 'M', 'marquee', false);
export const ellipseTool = makeMarquee('ellipse', 'Elliptical Marquee', 'M', 'ellipse', true);

export const lassoTool = {
  id: 'lasso', name: 'Lasso', key: 'L', icon: 'lasso', cursor: 'crosshair', modules: ['edit'],
  options(bar) {
    modeOptions(bar);
    bar.append(el('span', { class: 'hint' }, 'Drag to draw a freehand selection'));
  },
  onDown(e, p) {
    this.drag = { pts: [p], mode: modeFrom(e) };
  },
  onMove(e, p) {
    if (!this.drag) return;
    const last = this.drag.pts[this.drag.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) * app.view.view.zoom > 1.5) this.drag.pts.push(p);
  },
  onUp() {
    if (!this.drag) return;
    const { pts, mode } = this.drag;
    this.drag = null;
    if (pts.length < 3) {
      if (mode === 'replace' && app.doc.selection) { app.doc.setSelection(null); commit('Deselect'); }
      return;
    }
    applyShape('Lasso', mode, (g) => {
      pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
    });
  },
  drawOverlay(g, view) {
    if (!this.drag) return;
    g.beginPath();
    this.drag.pts.forEach((q, i) => {
      const s = view.docToScreen(q.x, q.y);
      if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y);
    });
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([4, 4]);
    g.strokeStyle = '#fff';
    g.stroke();
  },
};

export const wandTool = {
  id: 'wand', name: 'Magic Wand', key: 'W', icon: 'wand', cursor: 'crosshair', modules: ['edit'],
  tolerance: 32,
  contiguous: true,
  allLayers: true,
  options(bar) {
    modeOptions(bar, false);
    bar.append(
      numField({ label: 'Tolerance', value: this.tolerance, min: 0, max: 255, onChange: (v) => { this.tolerance = v; } }),
      checkField({ label: 'Contiguous', value: this.contiguous, onChange: (v) => { this.contiguous = v; } }),
      checkField({ label: 'Sample all layers', value: this.allLayers, onChange: (v) => { this.allLayers = v; } }),
    );
  },
  onDown(e, p) {
    const d = app.doc;
    let src;
    let ox = 0;
    let oy = 0;
    if (this.allLayers) {
      src = flatten(d);
    } else {
      const l = d.active;
      if (!l) return;
      src = layerImage(l, 1);
      ox = l.x;
      oy = l.y;
    }
    const data = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
    const mask = floodMask(data, p.x - ox, p.y - oy, this.tolerance, this.contiguous);
    let shape = maskToCanvas(mask, src.width, src.height);
    if (ox || oy || src.width !== d.width || src.height !== d.height) {
      const c = createCanvas(d.width, d.height);
      c.getContext('2d').drawImage(shape, ox, oy);
      shape = c;
    }
    // slight anti-aliasing of the edge
    shape = featherSelection(shape, 0.6);
    d.setSelection(combineSelection(d, shape, modeFrom(e)));
    commit('Magic Wand');
  },
};
