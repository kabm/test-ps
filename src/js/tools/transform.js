// Free Transform (Ctrl+T): move, scale and rotate the active layer.

import { app } from '../app.js';
import { applyLayerTransform } from '../ops.js';
import { layerImage, layerBounds } from '../render.js';
import { OBox } from './obox.js';
import { el } from '../util.js';
import { button, numField } from '../ui/widgets.js';

export const transformTool = {
  id: 'transform', name: 'Free Transform', key: null, icon: 'transform', cursor: 'move', modules: ['edit'],
  state: null,

  activate() {
    const d = app.doc;
    const l = d && d.active;
    if (!l) { app.status('Select a layer to transform.'); return; }
    const b = layerBounds(l);
    if (b.w < 1 || b.h < 1) return;
    this.state = { layer: l, w0: b.w, h0: b.h, box: new OBox(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, 0) };
    app.hiddenLayers = new Set([l]);
    app.render();
  },

  deactivate() {
    if (this.state) this.apply();
  },

  matrix() {
    const { w0, h0, box } = this.state;
    const a = box.rad;
    const sx = box.w / w0;
    const sy = box.h / h0;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // M = T(c) R S T(-w0/2,-h0/2)
    const m = { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy };
    m.e = box.cx - (m.a * w0) / 2 - (m.c * h0) / 2;
    m.f = box.cy - (m.b * w0) / 2 - (m.d * h0) / 2;
    return m;
  },

  apply() {
    const st = this.state;
    if (!st) return;
    const m = this.matrix();
    this.state = null;
    app.hiddenLayers = null;
    const { box, w0, h0, layer } = st;
    const unchanged = Math.abs(box.w - w0) < 0.01 && Math.abs(box.h - h0) < 0.01 && !box.angle;
    if (unchanged) {
      const b = layerBounds(layer);
      const dx = Math.round(box.cx - (b.x + b.w / 2));
      const dy = Math.round(box.cy - (b.y + b.h / 2));
      if (dx || dy) {
        layer.x += dx;
        layer.y += dy;
        app.doc.commit('Move');
      }
      app.render();
      return;
    }
    // the matrix maps the layer's local pixels to document coordinates
    applyLayerTransform(layer, m);
    app.render();
  },

  cancel() {
    this.state = null;
    app.hiddenLayers = null;
    app.render();
  },

  options(bar) {
    const st = this.state;
    bar.append(
      el('span', { class: 'hint' }, 'Drag handles to scale (Shift keeps proportions) · drag outside to rotate'),
      st ? numField({ label: 'W', value: Math.round((st.box.w / st.w0) * 100), min: 1, max: 5000, suffix: '%', onChange: (v) => { st.box.w = (st.w0 * v) / 100; app.view.requestFrame(); } }) : null,
      st ? numField({ label: 'H', value: Math.round((st.box.h / st.h0) * 100), min: 1, max: 5000, suffix: '%', onChange: (v) => { st.box.h = (st.h0 * v) / 100; app.view.requestFrame(); } }) : null,
      st ? numField({ label: 'Angle', value: 0, min: -360, max: 360, suffix: '°', onChange: (v) => { st.box.angle = v; app.view.requestFrame(); } }) : null,
      button({ label: 'Cancel', onClick: () => { this.cancel(); app.setTool('move'); } }),
      button({ label: 'Apply', iconName: 'check', cls: 'primary', onClick: () => { this.apply(); app.setTool('move'); } }),
    );
  },

  onKey(e) {
    if (e.key === 'Enter') { this.apply(); app.setTool('move'); return true; }
    if (e.key === 'Escape') { this.cancel(); app.setTool('move'); return true; }
    return false;
  },

  onDown(e, p, view) {
    if (!this.state) this.activate();
    if (!this.state) return;
    const hit = this.state.box.hitTest(p, view);
    this.drag = this.state.box.beginDrag(hit, p, { constrainAngle: 0, minSize: 1 });
  },
  onMove(e, p) {
    if (this.drag) this.drag(p, { shift: e.shiftKey });
  },
  onHover(e, p, view) {
    if (!this.state) return;
    view.canvas.style.cursor = OBox.cursorFor(this.state.box.hitTest(p, view), this.state.box.angle);
  },
  onUp() { this.drag = null; },
  onDblClick() { this.apply(); app.setTool('move'); },

  drawOverlay(g, view) {
    const st = this.state;
    if (!st) return;
    const img = layerImage(st.layer, 1);
    if (img) {
      const m = this.matrix();
      const v = view.view;
      const ox = view.cssW / 2 - v.cx * v.zoom;
      const oy = view.cssH / 2 - v.cy * v.zoom;
      const z = v.zoom;
      g.save();
      // view transform (doc -> screen) * layer transform
      g.transform(z, 0, 0, z, ox, oy);
      g.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      g.globalAlpha = st.layer.opacity;
      g.imageSmoothingEnabled = true;
      g.drawImage(img, 0, 0, st.w0, st.h0);
      g.restore();
    }
    st.box.draw(g, view);
  },
};
