// Crop & straighten tool.

import { app } from '../app.js';
import { cropTo } from '../ops.js';
import { OBox } from './obox.js';
import { el } from '../util.js';
import { selectField, slider, button } from '../ui/widgets.js';

const ASPECTS = [
  ['free', 'Free'], ['original', 'Original'], ['1:1', '1 : 1 (Square)'], ['4:5', '4 : 5'], ['5:7', '5 : 7'],
  ['4:3', '4 : 3'], ['3:2', '3 : 2'], ['16:9', '16 : 9'], ['9:16', '9 : 16 (Story)'],
];

export const cropTool = {
  id: 'crop', name: 'Crop & Straighten', key: 'C', icon: 'crop', cursor: 'crosshair', modules: ['develop', 'edit'],
  aspect: 'free',
  box: null,
  docRef: null,

  ratio() {
    const d = app.doc;
    if (this.aspect === 'free') return 0;
    if (this.aspect === 'original') return d.width / d.height;
    const [a, b] = this.aspect.split(':').map(Number);
    return a / b;
  },

  ensureBox() {
    const d = app.doc;
    if (!d) return null;
    if (!this.box || this.docRef !== d || this.docVersion !== d.width + 'x' + d.height) this.reset();
    return this.box;
  },

  reset() {
    const d = app.doc;
    this.docRef = d;
    this.docVersion = d.width + 'x' + d.height;
    this.box = new OBox(d.width / 2, d.height / 2, d.width, d.height, 0);
    this.applyAspect();
    if (this.angleEl) this.angleEl.set(0);
    app.view && app.view.requestFrame();
  },

  applyAspect() {
    const r = this.ratio();
    const b = this.box;
    if (!r || !b) return;
    const d = app.doc;
    let w = b.w;
    let h = w / r;
    if (h > d.height) { h = d.height; w = h * r; }
    if (w > d.width) { w = d.width; h = w / r; }
    b.w = w;
    b.h = h;
  },

  activate() {
    this.ensureBox();
  },

  options(bar) {
    this.ensureBox();
    this.angleEl = slider({
      label: 'Angle', min: -45, max: 45, step: 0.1, value: this.box ? this.box.angle : 0, def: 0,
      format: (v) => v.toFixed(1) + '°',
      onInput: (v) => { if (this.ensureBox()) { this.box.angle = v; app.view.requestFrame(); } },
    });
    bar.append(
      selectField({ label: 'Aspect', options: ASPECTS, value: this.aspect, onChange: (v) => { this.aspect = v; this.ensureBox(); this.applyAspect(); app.view.requestFrame(); } }),
      button({ label: 'Swap', iconName: 'rotate', title: 'Swap orientation', onClick: () => {
        const b = this.ensureBox();
        if (!b) return;
        [b.w, b.h] = [b.h, b.w];
        if (this.aspect.includes(':')) {
          const [a, c] = this.aspect.split(':');
          const flipped = `${c}:${a}`;
          if (ASPECTS.some(([k]) => k === flipped)) this.aspect = flipped;
        }
        app.view.requestFrame();
      } }),
      this.angleEl,
      button({ label: 'Reset', onClick: () => this.reset() }),
      button({ label: 'Apply', iconName: 'check', cls: 'primary', title: 'Apply crop (Enter)', onClick: () => this.apply() }),
      el('span', { class: 'hint' }, 'Drag handles to crop · drag outside to straighten'),
    );
  },

  apply() {
    const b = this.ensureBox();
    if (!b) return;
    const d = app.doc;
    const full = Math.abs(b.w - d.width) < 0.5 && Math.abs(b.h - d.height) < 0.5 && Math.abs(b.cx - d.width / 2) < 0.5 && Math.abs(b.cy - d.height / 2) < 0.5 && !b.angle;
    if (full) { app.status('Nothing to crop'); return; }
    cropTo({ x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h }, b.angle);
    this.reset();
    app.view.fit();
  },

  onKey(e) {
    if (e.key === 'Enter') { this.apply(); return true; }
    if (e.key === 'Escape') { this.reset(); return true; }
    return false;
  },

  onDown(e, p, view) {
    const b = this.ensureBox();
    if (!b) return;
    const hit = b.hitTest(p, view);
    this.drag = b.beginDrag(hit, p, { aspect: this.ratio(), constrainAngle: 45 });
    this.hit = hit;
  },
  onMove(e, p) {
    if (!this.drag) return;
    this.drag(p, { shift: e.shiftKey });
    if (this.hit === 'rotate' && this.angleEl) this.angleEl.set(Math.round(this.box.angle * 10) / 10);
  },
  onHover(e, p, view) {
    const b = this.ensureBox();
    if (!b) return;
    view.canvas.style.cursor = OBox.cursorFor(b.hitTest(p, view), b.angle);
  },
  onUp() { this.drag = null; },
  onDblClick() { this.apply(); },

  drawOverlay(g, view) {
    const b = this.ensureBox();
    if (!b) return;
    const pts = b.corners().map((q) => view.docToScreen(q.x, q.y));
    // dim everything outside the crop
    g.save();
    g.beginPath();
    g.rect(0, 0, view.cssW, view.cssH);
    pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fill('evenodd');
    g.restore();
    // rule of thirds
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.lineWidth = 1;
    g.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      const a = b.toDoc({ x: -b.w / 2 + b.w * t, y: -b.h / 2 });
      const c = b.toDoc({ x: -b.w / 2 + b.w * t, y: b.h / 2 });
      const sa = view.docToScreen(a.x, a.y);
      const sc = view.docToScreen(c.x, c.y);
      g.moveTo(sa.x, sa.y); g.lineTo(sc.x, sc.y);
      const d1 = b.toDoc({ x: -b.w / 2, y: -b.h / 2 + b.h * t });
      const d2 = b.toDoc({ x: b.w / 2, y: -b.h / 2 + b.h * t });
      const s1 = view.docToScreen(d1.x, d1.y);
      const s2 = view.docToScreen(d2.x, d2.y);
      g.moveTo(s1.x, s1.y); g.lineTo(s2.x, s2.y);
    }
    g.stroke();
    b.draw(g, view);
    // size label
    const label = `${Math.round(b.w)} × ${Math.round(b.h)}${b.angle ? `  ${b.angle.toFixed(1)}°` : ''}`;
    g.font = '12px "Segoe UI", sans-serif';
    const top = pts.reduce((m, q) => (q.y < m.y ? q : m), pts[0]);
    const tw = g.measureText(label).width + 12;
    const lx = Math.max(4, Math.min(view.cssW - tw - 4, top.x - tw / 2));
    const ly = top.y - 28 < 4 ? top.y + 8 : top.y - 28;
    g.fillStyle = 'rgba(0,0,0,0.7)';
    g.fillRect(lx, ly, tw, 20);
    g.fillStyle = '#fff';
    g.fillText(label, lx + 6, ly + 14);
  },
};
