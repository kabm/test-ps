// Spot healing: copy texture from a nearby, well-matching area and blend it in
// seamlessly by solving a Laplace equation for the colour difference (the
// classic "healing brush" approach).

import { clamp } from './util.js';

// target: canvas to modify in place. mask: canvas (same size) whose alpha marks the area.
// bounds: {x,y,w,h} of the painted area in target coords. Returns true if applied.
export function healArea(target, mask, bounds, brushSize = 20) {
  const W = target.width;
  const H = target.height;
  const pad = Math.max(4, Math.round(brushSize * 0.35));
  const rx = clamp(bounds.x - pad, 0, W);
  const ry = clamp(bounds.y - pad, 0, H);
  const rw = clamp(bounds.x + bounds.w + pad, 0, W) - rx;
  const rh = clamp(bounds.y + bounds.h + pad, 0, H) - ry;
  if (rw < 2 || rh < 2) return false;

  const tg = target.getContext('2d', { willReadFrequently: true });
  const mg = mask.getContext('2d', { willReadFrequently: true });
  const T = tg.getImageData(rx, ry, rw, rh);
  const M = mg.getImageData(rx, ry, rw, rh).data;
  const n = rw * rh;
  const alpha = new Float32Array(n);
  const unknown = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    alpha[i] = M[i * 4 + 3] / 255;
    unknown[i] = alpha[i] > 0.02 ? 1 : 0;
  }

  // --- choose a source offset with the best matching surroundings ---
  const D = Math.max(rw, rh) * 0.9 + 6;
  let best = null;
  const ringIdx = [];
  for (let y = 0; y < rh; y += 2) {
    for (let x = 0; x < rw; x += 2) {
      const i = y * rw + x;
      if (!unknown[i]) ringIdx.push(i);
    }
  }
  const td = T.data;
  for (let k = 0; k < 24; k++) {
    const ang = (k / 24) * Math.PI * 2;
    for (const dist of [D, D * 1.5]) {
      const dx = Math.round(Math.cos(ang) * dist);
      const dy = Math.round(Math.sin(ang) * dist);
      const sx = rx + dx;
      const sy = ry + dy;
      if (sx < 0 || sy < 0 || sx + rw > W || sy + rh > H) continue;
      const S = tg.getImageData(sx, sy, rw, rh).data;
      let ssd = 0;
      for (const i of ringIdx) {
        const o = i * 4;
        const a = td[o] - S[o];
        const b = td[o + 1] - S[o + 1];
        const c = td[o + 2] - S[o + 2];
        ssd += a * a + b * b + c * c;
      }
      // also penalise sources that themselves overlap the area
      const overlap = Math.abs(dx) < rw && Math.abs(dy) < rh ? 1e9 : 0;
      const score = ssd / Math.max(1, ringIdx.length) + overlap;
      if (!best || score < best.score) best = { score, S, dx, dy };
    }
  }
  const S = best ? best.S : new Uint8ClampedArray(n * 4);

  // --- solve Laplace(Diff)=0 inside, Diff = T - S on the boundary ---
  const maxSolve = 160;
  const k = Math.max(1, Math.ceil(Math.max(rw, rh) / maxSolve));
  const sw = Math.ceil(rw / k);
  const sh = Math.ceil(rh / k);
  const sn = sw * sh;
  const diff = [new Float32Array(sn), new Float32Array(sn), new Float32Array(sn)];
  const cnt = new Float32Array(sn);
  const sUnknown = new Uint8Array(sn);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      const j = Math.floor(y / k) * sw + Math.floor(x / k);
      if (unknown[i]) { sUnknown[j] = 1; continue; }
      const o = i * 4;
      diff[0][j] += td[o] - S[o];
      diff[1][j] += td[o + 1] - S[o + 1];
      diff[2][j] += td[o + 2] - S[o + 2];
      cnt[j]++;
    }
  }
  let mean = [0, 0, 0];
  let mc = 0;
  for (let j = 0; j < sn; j++) {
    if (cnt[j] && !sUnknown[j]) {
      for (let c = 0; c < 3; c++) { diff[c][j] /= cnt[j]; mean[c] += diff[c][j]; }
      mc++;
    } else if (cnt[j]) {
      for (let c = 0; c < 3; c++) diff[c][j] /= cnt[j];
    }
  }
  mean = mean.map((v) => (mc ? v / mc : 0));
  for (let j = 0; j < sn; j++) if (sUnknown[j]) for (let c = 0; c < 3; c++) diff[c][j] = mean[c];

  const omega = 1.92;
  const iters = Math.min(1200, 120 + Math.max(sw, sh) * 6);
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const j = y * sw + x;
        if (!sUnknown[j]) continue;
        const l = x > 0 ? j - 1 : j;
        const r = x < sw - 1 ? j + 1 : j;
        const u = y > 0 ? j - sw : j;
        const d = y < sh - 1 ? j + sw : j;
        for (let c = 0; c < 3; c++) {
          const a = diff[c];
          const avg = (a[l] + a[r] + a[u] + a[d]) * 0.25;
          a[j] += omega * (avg - a[j]);
        }
      }
    }
  }

  const sample = (a, fx, fy) => {
    const x = clamp(fx, 0, sw - 1);
    const y = clamp(fy, 0, sh - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(sw - 1, x0 + 1);
    const y1 = Math.min(sh - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    return (a[y0 * sw + x0] * (1 - tx) + a[y0 * sw + x1] * tx) * (1 - ty) + (a[y1 * sw + x0] * (1 - tx) + a[y1 * sw + x1] * tx) * ty;
  };

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      const a = alpha[i];
      if (a <= 0) continue;
      const o = i * 4;
      const fx = (x + 0.5) / k - 0.5;
      const fy = (y + 0.5) / k - 0.5;
      for (let c = 0; c < 3; c++) {
        const healed = S[o + c] + (k === 1 ? diff[c][i] : sample(diff[c], fx, fy));
        td[o + c] = td[o + c] * (1 - a) + clamp(healed, 0, 255) * a;
      }
    }
  }
  tg.putImageData(T, rx, ry);
  return true;
}
