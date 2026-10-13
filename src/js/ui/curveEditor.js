// Interactive tone curve editor (RGB + per-channel).

import { el, clamp, deepClone } from '../util.js';
import { curveFunction, sortPoints } from '../curves.js';
import { histogramData } from './histogram.js';

const CHANNELS = [
  ['master', '#e6e6e6', 'RGB'],
  ['r', '#e5484d', 'Red'],
  ['g', '#46c35a', 'Green'],
  ['b', '#4a7cf0', 'Blue'],
];

export function curveEditor({ get, onChange }) {
  let channel = 'master';
  const canvas = el('canvas', { width: 512, height: 512 });
  const tabs = el('div', { class: 'curve-tabs' });
  const tabBtns = CHANNELS.map(([k, color, label]) => {
    const b = el('button', { title: label, style: { background: color }, class: k === channel ? 'active' : '' });
    b.addEventListener('click', () => {
      channel = k;
      tabBtns.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      draw();
    });
    tabs.appendChild(b);
    return b;
  });
  const resetBtn = el('button', { class: 'btn', style: { marginLeft: 'auto', height: '22px', padding: '0 8px' } }, 'Reset');
  resetBtn.addEventListener('click', () => {
    const c = deepClone(get());
    c[channel] = [[0, 0], [1, 1]];
    onChange(c, true);
    draw();
  });
  tabs.appendChild(resetBtn);
  const node = el('div', { class: 'curve-editor' }, tabs, canvas,
    el('div', { class: 'note', style: { marginTop: '4px' } }, 'Click to add points · drag to adjust · double-click a point to remove'));

  const pts = () => get()[channel] || [[0, 0], [1, 1]];

  function toCanvas(p) {
    return { x: p[0] * canvas.width, y: (1 - p[1]) * canvas.height };
  }
  function fromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)];
  }

  function draw() {
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);
    // histogram
    const hd = histogramData();
    if (hd && hd.n) {
      const ch = channel === 'master' ? null : hd[channel];
      let max = 1;
      const val = (i) => (ch ? ch[i] : (hd.r[i] + hd.g[i] + hd.b[i]) / 3);
      for (let i = 2; i < 254; i++) max = Math.max(max, val(i));
      g.beginPath();
      g.moveTo(0, H);
      for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(val(i) / max)) * H * 0.9);
      g.lineTo(W, H);
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 4; i++) {
      g.moveTo((W * i) / 4, 0); g.lineTo((W * i) / 4, H);
      g.moveTo(0, (H * i) / 4); g.lineTo(W, (H * i) / 4);
    }
    g.moveTo(0, H); g.lineTo(W, 0);
    g.stroke();
    const color = CHANNELS.find((c) => c[0] === channel)[1];
    const p = sortPoints(pts());
    const f = curveFunction(p);
    g.beginPath();
    for (let i = 0; i <= 256; i++) {
      const x = i / 256;
      const y = clamp(f(x), 0, 1);
      if (i === 0) g.moveTo(x * W, (1 - y) * H); else g.lineTo(x * W, (1 - y) * H);
    }
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.stroke();
    for (const q of p) {
      const c = toCanvas(q);
      g.beginPath();
      g.arc(c.x, c.y, 9, 0, Math.PI * 2);
      g.fillStyle = '#1a1a1c';
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = color;
      g.stroke();
    }
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const curve = deepClone(get());
    const list = sortPoints(curve[channel] || [[0, 0], [1, 1]]);
    const m = fromEvent(e);
    const r = canvas.getBoundingClientRect();
    const tol = 12 / r.width;
    let idx = list.findIndex((q) => Math.abs(q[0] - m[0]) < tol && Math.abs(q[1] - m[1]) < tol * 1.5);
    if (idx < 0) {
      const f = curveFunction(list);
      list.push([m[0], clamp(Math.abs(f(m[0]) - m[1]) < 0.08 ? f(m[0]) : m[1], 0, 1)]);
      const sorted = sortPoints(list);
      idx = sorted.findIndex((q) => q[0] === m[0]);
      curve[channel] = sorted;
    } else {
      curve[channel] = list;
    }
    drag = { curve, idx };
    canvas.setPointerCapture(e.pointerId);
    onChange(curve, false);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const list = drag.curve[channel];
    const m = fromEvent(e);
    const i = drag.idx;
    const lo = i > 0 ? list[i - 1][0] + 0.01 : 0;
    const hi = i < list.length - 1 ? list[i + 1][0] - 0.01 : 1;
    list[i] = [clamp(m[0], lo, hi), m[1]];
    onChange(drag.curve, false);
    draw();
  });
  const end = () => {
    if (!drag) return;
    onChange(drag.curve, true);
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  const removeAt = (e) => {
    const curve = deepClone(get());
    const list = sortPoints(curve[channel] || []);
    const m = fromEvent(e);
    const r = canvas.getBoundingClientRect();
    const tol = 14 / r.width;
    const idx = list.findIndex((q) => Math.abs(q[0] - m[0]) < tol && Math.abs(q[1] - m[1]) < tol * 1.5);
    if (idx > 0 && idx < list.length - 1) {
      list.splice(idx, 1);
      curve[channel] = list;
      onChange(curve, true);
      draw();
    }
  };
  canvas.addEventListener('dblclick', removeAt);
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); removeAt(e); });

  node.refresh = draw;
  setTimeout(draw, 0);
  return node;
}
