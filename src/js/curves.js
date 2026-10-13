// Tone curve math: monotone cubic (Fritsch–Carlson) interpolation through
// control points in [0,1]x[0,1], sampled into 256-entry lookup tables.

export const IDENTITY_CURVE = [[0, 0], [1, 1]];

export function isIdentityCurve(points) {
  if (!points || points.length !== 2) return !points;
  return points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1;
}

export function sortPoints(points) {
  return points.slice().sort((a, b) => a[0] - b[0]);
}

// Returns a function f(x) for x in [0,1].
export function curveFunction(points) {
  const pts = sortPoints(points);
  const n = pts.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = new Array(n - 1);
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    d[i] = dx > 0 ? (ys[i + 1] - ys[i]) / dx : 0;
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    i = lo;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

export function curveLUT(points, size = 256) {
  const f = curveFunction(points);
  const lut = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const v = f(i / (size - 1));
    lut[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return lut;
}

// 256x4 RGBA8 texture data: rows master, red, green, blue (value in R channel).
export function curveTextureData(curve) {
  const data = new Uint8Array(256 * 4 * 4);
  const rows = [curve.master, curve.r, curve.g, curve.b];
  rows.forEach((pts, row) => {
    const lut = curveLUT(pts || IDENTITY_CURVE);
    for (let i = 0; i < 256; i++) {
      const v = Math.round(lut[i] * 255);
      const o = (row * 256 + i) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  });
  return data;
}
