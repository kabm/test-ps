// RGB histogram shared by the Develop & Edit panels.

import { el, createCanvas } from '../util.js';
import { app } from '../app.js';
import { exifSummary } from '../imageio.js';

const views = new Set();
let lastData = null;
let timer = null;
let pending = null;

export function histogramView() {
  const canvas = el('canvas');
  const info = el('div', { class: 'histo-info' });
  const node = el('div', {}, el('div', { class: 'histo' }, canvas), info);
  const v = { canvas, info, node };
  views.add(v);
  new ResizeObserver(() => draw(v)).observe(canvas);
  return node;
}

export function computeHistogram(source) {
  const maxW = 256;
  const s = Math.min(1, maxW / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * s));
  const h = Math.max(1, Math.round(source.height * s));
  const c = computeHistogram._c || (computeHistogram._c = createCanvas(w, h));
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, w, h);
  g.drawImage(source, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const r = new Uint32Array(256);
  const gg = new Uint32Array(256);
  const b = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    r[d[i]]++;
    gg[d[i + 1]]++;
    b[d[i + 2]]++;
    n++;
  }
  return { r, g: gg, b, n };
}

export function updateHistogram(source) {
  pending = source;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!pending) return;
    try {
      lastData = computeHistogram(pending);
    } catch {
      lastData = null;
    }
    pending = null;
    for (const v of views) draw(v);
  }, 120);
}

export function clearHistogram() {
  lastData = null;
  for (const v of views) draw(v);
}

function draw(v) {
  const { canvas, info } = v;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width;
  const H = rect.height;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.beginPath();
  for (let i = 1; i < 4; i++) { g.moveTo((W * i) / 4, 0); g.lineTo((W * i) / 4, H); }
  g.stroke();
  const d = app.doc && app.doc.exif;
  info.textContent = d ? exifSummary(d) : '';
  if (!lastData || !lastData.n) return;
  let max = 1;
  for (const ch of [lastData.r, lastData.g, lastData.b]) {
    for (let i = 2; i < 254; i++) max = Math.max(max, ch[i]);
  }
  g.globalCompositeOperation = 'lighter';
  const colors = ['rgba(235,70,70,0.75)', 'rgba(70,200,90,0.75)', 'rgba(70,120,240,0.8)'];
  [lastData.r, lastData.g, lastData.b].forEach((ch, k) => {
    g.beginPath();
    g.moveTo(0, H);
    for (let i = 0; i < 256; i++) {
      const v2 = Math.min(1, Math.sqrt(ch[i] / max));
      g.lineTo((i / 255) * W, H - v2 * (H - 4));
    }
    g.lineTo(W, H);
    g.closePath();
    g.fillStyle = colors[k];
    g.fill();
  });
  g.globalCompositeOperation = 'source-over';
  // clipping indicators
  const clipLo = lastData.r[0] + lastData.g[0] + lastData.b[0];
  const clipHi = lastData.r[255] + lastData.g[255] + lastData.b[255];
  const tri = (x, on, dir) => {
    g.beginPath();
    g.moveTo(x, 4);
    g.lineTo(x + dir * 9, 4);
    g.lineTo(x, 13);
    g.closePath();
    g.fillStyle = on ? '#fff' : 'rgba(255,255,255,0.18)';
    g.fill();
  };
  tri(4, clipLo / lastData.n > 0.004, 1);
  tri(W - 4, clipHi / lastData.n > 0.004, -1);
}

export function histogramData() {
  return lastData;
}
