// Stamp-based brush engine. A stroke paints dabs into a stroke buffer which is
// merged onto a copy of the original pixels, so opacity never builds up within
// one stroke (like Photoshop) and selections clip the result.

import { createCanvas, cloneCanvas, clamp } from './util.js';

const stampCache = new Map();

export function makeStamp(diameter, hardness, color = '#ffffff') {
  const d = Math.max(1, diameter);
  const key = `${Math.round(d * 4) / 4}|${Math.round(hardness * 100)}|${color}`;
  let c = stampCache.get(key);
  if (c) return c;
  const size = Math.ceil(d) + 2;
  c = createCanvas(size, size);
  const g = c.getContext('2d');
  const r = d / 2;
  const cx = size / 2;
  if (hardness >= 0.99 || d < 3) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cx, r, 0, Math.PI * 2);
    g.fill();
  } else {
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r);
    const { r: cr, g: cg, b: cb } = parseColor(color);
    const h = clamp(hardness, 0, 0.98);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
    grad.addColorStop(h, `rgba(${cr},${cg},${cb},1)`);
    // smooth falloff
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const a = Math.pow(1 - t, 1.6) * (1 - t * 0.2);
      grad.addColorStop(h + (1 - h) * t, `rgba(${cr},${cg},${cb},${a.toFixed(3)})`);
    }
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  if (stampCache.size > 64) stampCache.clear();
  stampCache.set(key, c);
  return c;
}

function parseColor(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// mode: 'paint' | 'erase' | 'clone' | 'mask-reveal' | 'mask-hide' | 'collect'
export class Stroke {
  constructor({ target, mode, color = '#000', size = 20, hardness = 0.8, opacity = 1, flow = 1, spacing = 0.15,
    pressure = false, selection = null, cloneSource = null, cloneOffset = null, onUpdate = null }) {
    this.target = target; // canvas being modified (already copy-on-write)
    this.mode = mode;
    this.color = color;
    this.size = size;
    this.hardness = hardness;
    this.opacity = opacity;
    this.flow = flow;
    this.spacing = spacing;
    this.pressure = pressure;
    this.selection = selection; // canvas in target coords, or null
    this.cloneSource = cloneSource;
    this.cloneOffset = cloneOffset;
    this.onUpdate = onUpdate;
    this.base = mode === 'collect' ? null : cloneCanvas(target);
    this.buffer = createCanvas(target.width, target.height);
    this.bufCtx = this.buffer.getContext('2d');
    this.tmp = null;
    this.last = null;
    this.residual = 0;
    this.bounds = null;
    this.dabCanvas = null;
  }

  begin(p, pressure = 1) {
    this.last = { x: p.x, y: p.y, p: pressure };
    this.dab(p.x, p.y, pressure);
    this.flush();
  }

  add(p, pressure = 1) {
    if (!this.last) return this.begin(p, pressure);
    const dx = p.x - this.last.x;
    const dy = p.y - this.last.y;
    const dist = Math.hypot(dx, dy);
    const sizeAt = (pr) => (this.pressure ? Math.max(1, this.size * pr) : this.size);
    const step = Math.max(0.5, sizeAt(pressure) * this.spacing);
    let t = step - this.residual;
    if (dist < 1e-6) return;
    while (t <= dist) {
      const f = t / dist;
      const pr = this.last.p + (pressure - this.last.p) * f;
      this.dab(this.last.x + dx * f, this.last.y + dy * f, pr);
      t += step;
    }
    this.residual = dist - (t - step);
    this.last = { x: p.x, y: p.y, p: pressure };
    this.flush();
  }

  dab(x, y, pr) {
    const size = this.pressure ? Math.max(1, this.size * pr) : this.size;
    // stamps are alpha-only; the paint colour is applied exactly at composite time
    const stamp = makeStamp(size, this.hardness, '#ffffff');
    const sx = x - stamp.width / 2;
    const sy = y - stamp.height / 2;
    const g = this.bufCtx;
    g.globalAlpha = clamp(this.flow, 0.01, 1);
    if (this.mode === 'clone' && this.cloneSource && this.cloneOffset) {
      if (!this.dabCanvas || this.dabCanvas.width !== stamp.width) this.dabCanvas = createCanvas(stamp.width, stamp.height);
      const dg = this.dabCanvas.getContext('2d');
      dg.globalCompositeOperation = 'source-over';
      dg.clearRect(0, 0, stamp.width, stamp.height);
      dg.drawImage(stamp, 0, 0);
      dg.globalCompositeOperation = 'source-in';
      dg.drawImage(this.cloneSource, -(sx + this.cloneOffset.x), -(sy + this.cloneOffset.y));
      g.drawImage(this.dabCanvas, sx, sy);
    } else {
      g.drawImage(stamp, sx, sy);
    }
    g.globalAlpha = 1;
    const r = { x: Math.floor(sx) - 1, y: Math.floor(sy) - 1, w: stamp.width + 2, h: stamp.height + 2 };
    this.pending = this.pending ? union(this.pending, r) : r;
  }

  flush() {
    const r = this.pending;
    if (!r) return;
    this.pending = null;
    const rect = clip(r, this.target.width, this.target.height);
    if (!rect) return;
    this.bounds = this.bounds ? union(this.bounds, rect) : rect;
    if (this.mode === 'collect') {
      if (this.onUpdate) this.onUpdate(rect);
      return;
    }
    const g = this.target.getContext('2d');
    const { x, y, w, h } = rect;
    // restore the untouched pixels of this rect, then lay the stroke on top
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(x, y, w, h);
    g.drawImage(this.base, x, y, w, h, x, y, w, h);
    g.restore();
    let src = this.buffer;
    if (this.selection || this.mode === 'paint') {
      if (!this.tmp) this.tmp = createCanvas(this.target.width, this.target.height);
      const tg = this.tmp.getContext('2d');
      tg.globalCompositeOperation = 'source-over';
      tg.clearRect(x, y, w, h);
      tg.drawImage(this.buffer, x, y, w, h, x, y, w, h);
      if (this.mode === 'paint') {
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = this.color;
        tg.fillRect(x, y, w, h);
      }
      if (this.selection) {
        tg.globalCompositeOperation = 'destination-in';
        tg.drawImage(this.selection, x, y, w, h, x, y, w, h);
      }
      tg.globalCompositeOperation = 'source-over';
      src = this.tmp;
    }
    g.save();
    g.globalAlpha = this.opacity;
    g.globalCompositeOperation = this.mode === 'erase' || this.mode === 'mask-hide' ? 'destination-out' : 'source-over';
    g.drawImage(src, x, y, w, h, x, y, w, h);
    g.restore();
    if (this.onUpdate) this.onUpdate(rect);
  }
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function clip(r, W, H) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const x2 = Math.min(W, r.x + r.w);
  const y2 = Math.min(H, r.y + r.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}
