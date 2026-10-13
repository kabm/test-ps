// Move, Hand, Zoom, Eyedropper, White-balance picker.

import { app } from '../app.js';
import { commit, setDevelop, activeDevelopLayer } from '../ops.js';
import { layerImage, layerBounds } from '../render.js';
import { rgbToHex, el } from '../util.js';
import { whiteBalanceFromPixel } from '../develop.js';
import { checkField } from '../ui/widgets.js';

function pickLayerAt(d, p) {
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const l = d.layers[i];
    if (!l.visible) continue;
    const b = layerBounds(l);
    if (p.x < b.x || p.y < b.y || p.x >= b.x + b.w || p.y >= b.y + b.h) continue;
    if (l.type === 'text') return l;
    const img = layerImage(l, 1);
    const a = img.getContext('2d').getImageData(Math.floor(p.x - l.x), Math.floor(p.y - l.y), 1, 1).data[3];
    if (a > 10) return l;
  }
  return null;
}

export const moveTool = {
  id: 'move', name: 'Move', key: 'V', icon: 'move', cursor: 'move', modules: ['edit'],
  autoSelect: false,
  options(bar) {
    bar.append(
      checkField({ label: 'Auto-select layer', value: this.autoSelect, onChange: (v) => { this.autoSelect = v; } }),
      el('span', { class: 'hint' }, 'Drag to move the layer · Arrow keys nudge (Shift = 10px)'),
    );
  },
  onDown(e, p) {
    const d = app.doc;
    if (this.autoSelect || e.ctrlKey) {
      const l = pickLayerAt(d, p);
      if (l && l !== d.active) { d.setActive(l); app.maskEditing = false; }
    }
    const l = d.active;
    if (!l) return;
    this.drag = { l, x0: l.x, y0: l.y, p0: p, moved: false };
  },
  onMove(e, p) {
    if (!this.drag) return;
    const { l, x0, y0, p0 } = this.drag;
    let dx = p.x - p0.x;
    let dy = p.y - p0.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    l.x = Math.round(x0 + dx);
    l.y = Math.round(y0 + dy);
    this.drag.moved = l.x !== x0 || l.y !== y0;
    app.render();
  },
  onUp() {
    if (this.drag && this.drag.moved) commit('Move');
    this.drag = null;
  },
};

export const handTool = {
  id: 'hand', name: 'Hand', key: 'H', icon: 'hand', cursor: 'grab', modules: ['develop', 'edit'],
  options(bar) {
    bar.append(el('span', { class: 'hint' }, 'Drag to pan · Hold Space with any tool · Mouse wheel zooms'));
  },
  onDblClick() { app.view.fit(); },
};

export const zoomTool = {
  id: 'zoom', name: 'Zoom', key: 'Z', icon: 'zoom', cursor: 'zoom-in', modules: ['develop', 'edit'],
  options(bar) {
    bar.append(el('span', { class: 'hint' }, 'Click to zoom in · Alt+click to zoom out · Double-click to fit'));
  },
  onDown(e, p, view) {
    const sp = view.docToScreen(p.x, p.y);
    view.zoomBy(e.altKey || e.button === 2 ? 0.5 : 2, sp);
  },
  onDblClick() { app.view.fit(); },
};

export const eyedropperTool = {
  id: 'eyedropper', name: 'Eyedropper', key: 'I', icon: 'eyedropper', cursor: 'crosshair', modules: ['edit'],
  options(bar) {
    bar.append(el('span', { class: 'hint' }, 'Click to pick the foreground color · Alt+click picks the background color'));
  },
  pick(e, p, view) {
    const c = view.sampleColor(p.x, p.y);
    if (!c) return;
    const hex = rgbToHex(c[0], c[1], c[2]);
    if (e.altKey) app.bg = hex; else app.fg = hex;
    app.emit('colors');
  },
  onDown(e, p, view) { this.pick(e, p, view); },
  onMove(e, p, view) { this.pick(e, p, view); },
};

export const wbTool = {
  id: 'wb', name: 'White Balance Picker', key: 'W', icon: 'wb', cursor: 'crosshair', modules: ['develop'],
  options(bar) {
    bar.append(el('span', { class: 'hint' }, 'Click something that should be neutral grey or white to fix the white balance'));
  },
  onDown(e, p) {
    const l = activeDevelopLayer();
    if (!l) return;
    const lx = p.x - l.x;
    const ly = p.y - l.y;
    if (lx < 0 || ly < 0 || lx >= l.width || ly >= l.height) return;
    const wb = whiteBalanceFromPixel(l.canvas, lx, ly);
    setDevelop({ ...l.develop, ...wb }, 'White Balance');
    app.status(`White balance set: Temp ${wb.temp}, Tint ${wb.tint}`);
    if (this.returnTo) app.setTool(this.returnTo);
  },
};

