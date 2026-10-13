// Destructive filters & adjustments (Filter and Image > Adjustments menus).

import { getGL, GLSL_COMMON } from './gl.js';
import { createCanvas } from './util.js';

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform vec2 u_size;
${GLSL_COMMON}
`;

export function blurCanvas(src, r) {
  if (r <= 0) return src;
  const w = src.width;
  const h = src.height;
  const pad = Math.ceil(r * 2.5) + 2;
  const c = createCanvas(w + pad * 2, h + pad * 2);
  const g = c.getContext('2d');
  g.drawImage(src, pad, pad);
  g.drawImage(src, 0, 0, 1, h, 0, pad, pad, h);
  g.drawImage(src, w - 1, 0, 1, h, pad + w, pad, pad, h);
  g.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
  g.drawImage(src, 0, h - 1, w, 1, pad, pad + h, w, pad);
  g.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
  g.drawImage(src, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  g.drawImage(src, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  g.drawImage(src, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);
  const out = createCanvas(w, h);
  const og = out.getContext('2d');
  og.filter = `blur(${r}px)`;
  og.drawImage(c, -pad, -pad);
  return out;
}

const SHADERS = {
  motion: HEAD + `
uniform float u_angle; uniform float u_dist;
void main() {
  vec2 dir = vec2(cos(u_angle), sin(u_angle)) * u_dist * u_texel;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    float t = float(i) / 47.0 - 0.5;
    sum += texture(u_src, v_uv + dir * t);
  }
  o = sum / 48.0;
}`,
  unsharp: HEAD + `
uniform sampler2D u_blur; uniform float u_amount; uniform float u_threshold;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec4 b = texture(u_blur, v_uv);
  vec3 diff = c.rgb - b.rgb;
  float m = step(u_threshold, abs(luma(diff)) );
  o = vec4(clamp(c.rgb + diff * u_amount * m, 0.0, 1.0), c.a);
}`,
  noise: HEAD + `
uniform float u_amount; uniform float u_mono; uniform float u_seed;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec2 p = v_uv * u_size + u_seed;
  float n1 = hash12(p) - 0.5;
  vec3 n = u_mono > 0.5 ? vec3(n1) : vec3(n1, hash12(p + 37.1) - 0.5, hash12(p + 91.7) - 0.5);
  o = vec4(clamp(c.rgb + n * u_amount, 0.0, 1.0), c.a);
}`,
  emboss: HEAD + `
uniform float u_angle; uniform float u_height; uniform float u_amount;
void main() {
  vec2 d = vec2(cos(u_angle), sin(u_angle)) * u_height * u_texel;
  vec4 c = texture(u_src, v_uv);
  float a = luma(texture(u_src, v_uv - d).rgb);
  float b = luma(texture(u_src, v_uv + d).rgb);
  float e = 0.5 + (b - a) * u_amount;
  o = vec4(vec3(clamp(e, 0.0, 1.0)), c.a);
}`,
  edges: HEAD + `
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 tl = texture(u_src, v_uv + u_texel * vec2(-1, 1)).rgb;
  vec3 t  = texture(u_src, v_uv + u_texel * vec2(0, 1)).rgb;
  vec3 tr = texture(u_src, v_uv + u_texel * vec2(1, 1)).rgb;
  vec3 l  = texture(u_src, v_uv + u_texel * vec2(-1, 0)).rgb;
  vec3 r  = texture(u_src, v_uv + u_texel * vec2(1, 0)).rgb;
  vec3 bl = texture(u_src, v_uv + u_texel * vec2(-1, -1)).rgb;
  vec3 b  = texture(u_src, v_uv + u_texel * vec2(0, -1)).rgb;
  vec3 br = texture(u_src, v_uv + u_texel * vec2(1, -1)).rgb;
  vec3 gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  vec3 gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
  vec3 g = sqrt(gx * gx + gy * gy);
  o = vec4(clamp(1.0 - g, 0.0, 1.0), c.a);
}`,
  oil: HEAD + `
uniform float u_radius;
void main() {
  vec4 c0 = texture(u_src, v_uv);
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  int R = int(u_radius);
  float n = float((R + 1) * (R + 1));
  for (int j = -8; j <= 8; j++) {
    for (int i = -8; i <= 8; i++) {
      if (abs(i) > R || abs(j) > R) continue;
      vec3 c = texture(u_src, v_uv + vec2(float(i), float(j)) * u_texel).rgb;
      if (i <= 0 && j <= 0) { m[0] += c; s[0] += c * c; }
      if (i >= 0 && j <= 0) { m[1] += c; s[1] += c * c; }
      if (i <= 0 && j >= 0) { m[2] += c; s[2] += c * c; }
      if (i >= 0 && j >= 0) { m[3] += c; s[3] += c * c; }
    }
  }
  float best = 1e9; vec3 res = c0.rgb;
  for (int k = 0; k < 4; k++) {
    vec3 mean = m[k] / n;
    vec3 v = abs(s[k] / n - mean * mean);
    float sv = v.r + v.g + v.b;
    if (sv < best) { best = sv; res = mean; }
  }
  o = vec4(res, c0.a);
}`,
  posterize: HEAD + `
uniform float u_levels;
void main() {
  vec4 c = texture(u_src, v_uv);
  float l = max(u_levels - 1.0, 1.0);
  o = vec4(floor(c.rgb * l + 0.5) / l, c.a);
}`,
  threshold: HEAD + `
uniform float u_level;
void main() {
  vec4 c = texture(u_src, v_uv);
  o = vec4(vec3(step(u_level, luma(c.rgb))), c.a);
}`,
  invert: HEAD + `void main() { vec4 c = texture(u_src, v_uv); o = vec4(1.0 - c.rgb, c.a); }`,
  desaturate: HEAD + `void main() { vec4 c = texture(u_src, v_uv); o = vec4(vec3(luma(c.rgb)), c.a); }`,
  sepia: HEAD + `
uniform float u_amount;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)));
  o = vec4(clamp(mix(c.rgb, s, u_amount), 0.0, 1.0), c.a);
}`,
  glow: HEAD + `
uniform sampler2D u_blur; uniform float u_amount;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 b = texture(u_blur, v_uv).rgb;
  vec3 scr = 1.0 - (1.0 - c.rgb) * (1.0 - b);
  o = vec4(mix(c.rgb, scr, u_amount), c.a);
}`,
  brightness: HEAD + `
uniform float u_brightness; uniform float u_contrast;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 p = c.rgb + u_brightness;
  p = (p - 0.5) * (1.0 + u_contrast) + 0.5;
  o = vec4(clamp(p, 0.0, 1.0), c.a);
}`,
  huesat: HEAD + `
uniform float u_hue; uniform float u_sat; uniform float u_light;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 h = rgb2hsv(c.rgb);
  h.x = fract(h.x + u_hue + 1.0);
  h.y = clamp(h.y * (1.0 + u_sat), 0.0, 1.0);
  vec3 p = hsv2rgb(h);
  p = u_light > 0.0 ? mix(p, vec3(1.0), u_light) : p * (1.0 + u_light);
  o = vec4(p, c.a);
}`,
  levels: HEAD + `
uniform float u_inBlack; uniform float u_inWhite; uniform float u_gamma; uniform float u_outBlack; uniform float u_outWhite;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 p = clamp((c.rgb - u_inBlack) / max(u_inWhite - u_inBlack, 0.001), 0.0, 1.0);
  p = pow(p, vec3(1.0 / u_gamma));
  p = mix(vec3(u_outBlack), vec3(u_outWhite), p);
  o = vec4(p, c.a);
}`,
  vignette: HEAD + `
uniform float u_amount; uniform float u_size;
void main() {
  vec4 c = texture(u_src, v_uv);
  float r = length((v_uv - 0.5) * 2.0) / 1.41421;
  float v = smoothstep(u_size, 1.0, r);
  o = vec4(c.rgb * (1.0 - v * u_amount), c.a);
}`,
};

function gl(id, src, uniforms, extra) {
  return getGL().filter(SHADERS[id], src, uniforms, extra);
}

// Each filter: { id, name, params: [...], run(canvas, values) -> canvas }
export const FILTERS = {
  gaussian: {
    name: 'Gaussian Blur', menu: 'Blur',
    params: [{ key: 'radius', label: 'Radius', min: 0.1, max: 250, step: 0.1, def: 4, unit: 'px' }],
    run: (c, v) => blurCanvas(c, v.radius),
  },
  motion: {
    name: 'Motion Blur', menu: 'Blur',
    params: [
      { key: 'angle', label: 'Angle', min: -90, max: 90, step: 1, def: 0, unit: '°' },
      { key: 'distance', label: 'Distance', min: 1, max: 400, step: 1, def: 30, unit: 'px' },
    ],
    run: (c, v) => gl('motion', c, { u_angle: (v.angle * Math.PI) / 180, u_dist: v.distance }),
  },
  glow: {
    name: 'Soft Glow', menu: 'Blur',
    params: [
      { key: 'radius', label: 'Radius', min: 1, max: 200, step: 1, def: 20, unit: 'px' },
      { key: 'amount', label: 'Strength', min: 0, max: 100, step: 1, def: 40, unit: '%' },
    ],
    run: (c, v) => gl('glow', c, { u_amount: v.amount / 100 }, { u_blur: blurCanvas(c, v.radius) }),
  },
  unsharp: {
    name: 'Unsharp Mask', menu: 'Sharpen',
    params: [
      { key: 'amount', label: 'Amount', min: 1, max: 500, step: 1, def: 80, unit: '%' },
      { key: 'radius', label: 'Radius', min: 0.1, max: 50, step: 0.1, def: 1.5, unit: 'px' },
      { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, def: 2, unit: '' },
    ],
    run: (c, v) => gl('unsharp', c, { u_amount: v.amount / 100, u_threshold: v.threshold / 255 }, { u_blur: blurCanvas(c, v.radius) }),
  },
  noise: {
    name: 'Add Noise', menu: 'Noise',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, def: 12, unit: '%' },
      { key: 'mono', label: 'Monochromatic', type: 'bool', def: true },
    ],
    run: (c, v) => gl('noise', c, { u_amount: v.amount / 100, u_mono: v.mono ? 1 : 0, u_seed: Math.random() * 1000 }),
  },
  pixelate: {
    name: 'Pixelate', menu: 'Stylize',
    params: [{ key: 'size', label: 'Cell size', min: 2, max: 200, step: 1, def: 12, unit: 'px' }],
    run: (c, v) => {
      const w = Math.max(1, Math.round(c.width / v.size));
      const h = Math.max(1, Math.round(c.height / v.size));
      const small = createCanvas(w, h);
      const sg = small.getContext('2d');
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(c, 0, 0, w, h);
      const out = createCanvas(c.width, c.height);
      const og = out.getContext('2d');
      og.imageSmoothingEnabled = false;
      og.drawImage(small, 0, 0, c.width, c.height);
      return out;
    },
  },
  oil: {
    name: 'Oil Paint', menu: 'Stylize',
    params: [{ key: 'radius', label: 'Brush size', min: 1, max: 8, step: 1, def: 4, unit: '' }],
    run: (c, v) => gl('oil', c, { u_radius: v.radius }),
  },
  emboss: {
    name: 'Emboss', menu: 'Stylize',
    params: [
      { key: 'angle', label: 'Angle', min: -180, max: 180, step: 1, def: 135, unit: '°' },
      { key: 'height', label: 'Height', min: 1, max: 10, step: 1, def: 2, unit: 'px' },
      { key: 'amount', label: 'Amount', min: 1, max: 500, step: 1, def: 200, unit: '%' },
    ],
    run: (c, v) => gl('emboss', c, { u_angle: (v.angle * Math.PI) / 180, u_height: v.height, u_amount: v.amount / 100 }),
  },
  edges: { name: 'Find Edges', menu: 'Stylize', params: [], run: (c) => gl('edges', c, {}) },
  posterize: {
    name: 'Posterize', menu: 'Stylize',
    params: [{ key: 'levels', label: 'Levels', min: 2, max: 32, step: 1, def: 5, unit: '' }],
    run: (c, v) => gl('posterize', c, { u_levels: v.levels }),
  },
  threshold: {
    name: 'Threshold', menu: 'Stylize',
    params: [{ key: 'level', label: 'Level', min: 1, max: 255, step: 1, def: 128, unit: '' }],
    run: (c, v) => gl('threshold', c, { u_level: v.level / 255 }),
  },
  vignette: {
    name: 'Vignette', menu: 'Stylize',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, def: 50, unit: '%' },
      { key: 'size', label: 'Size', min: 0, max: 95, step: 1, def: 40, unit: '%' },
    ],
    run: (c, v) => gl('vignette', c, { u_amount: v.amount / 100, u_size: v.size / 100 }),
  },
  // --- adjustments (Image > Adjustments) ---
  brightness: {
    name: 'Brightness/Contrast', menu: 'Adjust',
    params: [
      { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, def: 0, unit: '' },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, def: 0, unit: '' },
    ],
    run: (c, v) => gl('brightness', c, { u_brightness: v.brightness / 200, u_contrast: v.contrast / 100 }),
  },
  huesat: {
    name: 'Hue/Saturation', menu: 'Adjust',
    params: [
      { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, def: 0, unit: '°' },
      { key: 'sat', label: 'Saturation', min: -100, max: 100, step: 1, def: 0, unit: '' },
      { key: 'light', label: 'Lightness', min: -100, max: 100, step: 1, def: 0, unit: '' },
    ],
    run: (c, v) => gl('huesat', c, { u_hue: v.hue / 360, u_sat: v.sat / 100, u_light: v.light / 100 }),
  },
  levels: {
    name: 'Levels', menu: 'Adjust',
    params: [
      { key: 'inBlack', label: 'Input black', min: 0, max: 253, step: 1, def: 0, unit: '' },
      { key: 'gamma', label: 'Midtones (gamma)', min: 0.1, max: 9.99, step: 0.01, def: 1, unit: '' },
      { key: 'inWhite', label: 'Input white', min: 2, max: 255, step: 1, def: 255, unit: '' },
      { key: 'outBlack', label: 'Output black', min: 0, max: 255, step: 1, def: 0, unit: '' },
      { key: 'outWhite', label: 'Output white', min: 0, max: 255, step: 1, def: 255, unit: '' },
    ],
    run: (c, v) => gl('levels', c, { u_inBlack: v.inBlack / 255, u_inWhite: v.inWhite / 255, u_gamma: v.gamma, u_outBlack: v.outBlack / 255, u_outWhite: v.outWhite / 255 }),
  },
  sepia: {
    name: 'Sepia Tone', menu: 'Adjust',
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, def: 100, unit: '%' }],
    run: (c, v) => gl('sepia', c, { u_amount: v.amount / 100 }),
  },
  invert: { name: 'Invert', menu: 'Adjust', params: [], run: (c) => gl('invert', c, {}) },
  desaturate: { name: 'Desaturate', menu: 'Adjust', params: [], run: (c) => gl('desaturate', c, {}) },
};

export function defaultsFor(id) {
  const o = {};
  for (const p of FILTERS[id].params) o[p.key] = p.def;
  return o;
}
