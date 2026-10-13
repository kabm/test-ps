// Hue/saturation wheel for color grading.

import { el, clamp, hsvToRgb } from '../util.js';

let wheelImage = null;
function wheelBitmap(size) {
  if (wheelImage && wheelImage.width === size) return wheelImage;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - r + 0.5;
      const dy = y - r + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      const i = (y * size + x) * 4;
      if (d > 1) continue;
      const hue = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
      const [rr, gg, bb] = hsvToRgb(hue, d * 0.85, 0.75);
      img.data[i] = rr * 255;
      img.data[i + 1] = gg * 255;
      img.data[i + 2] = bb * 255;
      img.data[i + 3] = d > 0.985 ? (1 - (d - 0.985) / 0.015) * 255 : 255;
    }
  }
  g.putImageData(img, 0, 0);
  wheelImage = c;
  return c;
}

export function colorWheel({ label, h = 0, s = 0, onChange }) {
  const size = 200;
  const canvas = el('canvas', { width: size, height: size });
  const valueEl = el('span', {});
  const node = el('div', { class: 'wheel' }, el('span', {}, label), canvas, valueEl);
  let H = h;
  let S = s;
  function draw() {
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, size, size);
    g.drawImage(wheelBitmap(size), 0, 0);
    const r = size / 2;
    const a = (H * Math.PI) / 180;
    const d = (S / 100) * (r - 6);
    const x = r + Math.cos(a) * d;
    const y = r - Math.sin(a) * d;
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.lineWidth = 3;
    g.strokeStyle = '#fff';
    g.stroke();
    g.lineWidth = 1;
    g.strokeStyle = '#000';
    g.stroke();
    valueEl.textContent = S ? `${Math.round(H)}° · ${Math.round(S)}` : '–';
  }
  function setFrom(e) {
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left) / rect.width - 0.5;
    const dy = (e.clientY - rect.top) / rect.height - 0.5;
    H = Math.round(((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360);
    S = Math.round(clamp(Math.hypot(dx, dy) / 0.47, 0, 1) * 100);
    draw();
  }
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    setFrom(e);
    onChange(H, S, false);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setFrom(e);
    onChange(H, S, false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    onChange(H, S, true);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', () => {
    S = 0;
    draw();
    onChange(H, S, true);
  });
  node.set = (h2, s2) => { H = h2; S = s2; draw(); };
  draw();
  return node;
}
