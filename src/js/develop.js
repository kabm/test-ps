// Non-destructive "Develop" engine (Lightroom-style adjustments) running on the GPU.

import { getGL, GLSL_COMMON } from './gl.js';
import { curveTextureData, isIdentityCurve, IDENTITY_CURVE } from './curves.js';
import { createCanvas, deepClone, hsvToRgb, clamp, fitSize, resizeCanvas } from './util.js';

export const HSL_BANDS = [
  { name: 'Red', hue: 0, color: '#e8423f' },
  { name: 'Orange', hue: 30, color: '#f08a2e' },
  { name: 'Yellow', hue: 60, color: '#efd43a' },
  { name: 'Green', hue: 120, color: '#47c447' },
  { name: 'Aqua', hue: 180, color: '#3cc9c9' },
  { name: 'Blue', hue: 240, color: '#3f6fe8' },
  { name: 'Purple', hue: 270, color: '#9a4fe0' },
  { name: 'Magenta', hue: 300, color: '#e04fbf' },
];

export function defaultDevelop() {
  return {
    temp: 0, tint: 0,
    exposure: 0, contrast: 0,
    highlights: 0, shadows: 0, whites: 0, blacks: 0,
    clarity: 0, dehaze: 0,
    vibrance: 0, saturation: 0,
    curve: { master: deepClone(IDENTITY_CURVE), r: deepClone(IDENTITY_CURVE), g: deepClone(IDENTITY_CURVE), b: deepClone(IDENTITY_CURVE) },
    hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0] },
    bw: false,
    grading: {
      shadows: { h: 220, s: 0 },
      midtones: { h: 40, s: 0 },
      highlights: { h: 45, s: 0 },
      balance: 0,
    },
    sharpen: 0, sharpenRadius: 1.0,
    noise: 0, colorNoise: 0,
    vignette: 0, vignetteMidpoint: 50, vignetteFeather: 50,
    grain: 0, grainSize: 25,
  };
}

// Normalise possibly partial/old settings into a full settings object.
export function normalizeDevelop(s) {
  const d = defaultDevelop();
  if (!s) return d;
  const out = { ...d, ...s };
  out.curve = { ...d.curve, ...(s.curve || {}) };
  out.hsl = {
    hue: (s.hsl && s.hsl.hue) || d.hsl.hue,
    sat: (s.hsl && s.hsl.sat) || d.hsl.sat,
    lum: (s.hsl && s.hsl.lum) || d.hsl.lum,
  };
  out.grading = {
    ...d.grading,
    ...(s.grading || {}),
    shadows: { ...d.grading.shadows, ...((s.grading && s.grading.shadows) || {}) },
    midtones: { ...d.grading.midtones, ...((s.grading && s.grading.midtones) || {}) },
    highlights: { ...d.grading.highlights, ...((s.grading && s.grading.highlights) || {}) },
  };
  return deepClone(out);
}

const SCALAR_KEYS = [
  'temp', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'clarity', 'dehaze', 'vibrance', 'saturation', 'sharpen', 'noise', 'colorNoise', 'vignette', 'grain',
];

export function isIdentityDevelop(s) {
  if (!s) return true;
  for (const k of SCALAR_KEYS) if (s[k]) return false;
  if (s.bw) return false;
  const c = s.curve;
  if (c && !(isIdentityCurve(c.master) && isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b))) return false;
  const h = s.hsl;
  if (h && (h.hue.some(Boolean) || h.sat.some(Boolean) || h.lum.some(Boolean))) return false;
  const g = s.grading;
  if (g && (g.shadows.s || g.midtones.s || g.highlights.s)) return false;
  return true;
}

export function developKey(s) {
  return isIdentityDevelop(s) ? 'id' : JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Shaders

const DOWNSAMPLE = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
void main() { o = texture(u_src, v_uv); }`;

const BLUR = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_dir;   // texel step * direction
uniform float u_sigma;
void main() {
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i);
    float w = exp(-0.5 * x * x / (u_sigma * u_sigma));
    sum += texture(u_src, v_uv + u_dir * x) * w;
    wsum += w;
  }
  o = sum / wsum;
}`;

const DENOISE = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_nr;    // 0..1 luminance
uniform float u_cnr;   // 0..1 color
${GLSL_COMMON}
void main() {
  vec4 c0 = texture(u_src, v_uv);
  float l0 = luma(c0.rgb);
  float sr = 0.015 + u_nr * 0.12;
  float lsum = 0.0, lw = 0.0;
  vec3 csum = vec3(0.0); float cw = 0.0;
  float step = 1.0 + u_cnr * 1.5;
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 off = vec2(float(i), float(j));
      vec3 s = texture(u_src, v_uv + off * u_texel).rgb;
      float ls = luma(s);
      float ds = dot(off, off);
      float dl = ls - l0;
      float w = exp(-ds / 8.0) * exp(-dl * dl / (2.0 * sr * sr));
      lsum += ls * w; lw += w;
      vec3 sc = texture(u_src, v_uv + off * u_texel * step).rgb;
      float wc = exp(-ds / 10.0) * exp(-pow(luma(sc) - l0, 2.0) / 0.02);
      csum += (sc - luma(sc)) * wc; cw += wc;
    }
  }
  float l = mix(l0, lsum / lw, clamp(u_nr * 1.4, 0.0, 1.0));
  vec3 chroma = mix(c0.rgb - l0, csum / cw, clamp(u_cnr * 1.2, 0.0, 1.0));
  o = vec4(clamp(vec3(l) + chroma, 0.0, 1.0), c0.a);
}`;

const DEVELOP = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_blurS;
uniform sampler2D u_blurL;
uniform sampler2D u_curve;
uniform vec2 u_texel;
uniform vec2 u_size;        // full-resolution reference size (for grain/vignette)
uniform vec3 u_wb;
uniform float u_exposure;
uniform float u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_clarity, u_dehaze, u_vibrance, u_saturation;
uniform float u_hslHue[8];
uniform float u_hslSat[8];
uniform float u_hslLum[8];
uniform int u_hsl;
uniform int u_bw;
uniform int u_useCurve;
uniform vec3 u_gradeS, u_gradeM, u_gradeH;
uniform float u_gradeBalance;
uniform int u_grade;
uniform float u_sharpen, u_sharpenRadius;
uniform float u_vignette, u_vigMid, u_vigFeather;
uniform float u_grain, u_grainSize;
${GLSL_COMMON}

const float CENTERS[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

void bandWeights(float h, out float w[8]) {
  for (int i = 0; i < 8; i++) w[i] = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = CENTERS[i];
    float b = CENTERS[i + 1];
    if (h >= a && h < b) {
      float t = (h - a) / (b - a);
      t = t * t * (3.0 - 2.0 * t);
      w[i] = 1.0 - t;
      int j = (i + 1) % 8;
      w[j] += t;
    }
  }
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 c = src.rgb;

  // Sharpening (unsharp mask on luminance)
  if (u_sharpen > 0.0) {
    vec2 r = u_texel * u_sharpenRadius;
    vec3 b = c * 4.0;
    b += (texture(u_src, v_uv + vec2(r.x, 0.0)).rgb + texture(u_src, v_uv - vec2(r.x, 0.0)).rgb +
          texture(u_src, v_uv + vec2(0.0, r.y)).rgb + texture(u_src, v_uv - vec2(0.0, r.y)).rgb) * 2.0;
    b += texture(u_src, v_uv + r).rgb + texture(u_src, v_uv - r).rgb +
         texture(u_src, v_uv + vec2(r.x, -r.y)).rgb + texture(u_src, v_uv + vec2(-r.x, r.y)).rgb;
    b /= 16.0;
    float detail = luma(c) - luma(b);
    c = clamp(c + detail * u_sharpen * 2.5, 0.0, 1.0);
  }

  vec3 lin = srgb2lin(c) * u_wb * u_exposure;
  vec3 blurL = srgb2lin(texture(u_blurL, v_uv).rgb) * u_wb * u_exposure;
  vec3 blurS = srgb2lin(texture(u_blurS, v_uv).rgb) * u_wb * u_exposure;

  // Dehaze (dark-channel style veil removal)
  if (u_dehaze != 0.0) {
    float dark = min(min(blurL.r, blurL.g), blurL.b);
    if (u_dehaze > 0.0) {
      float t = clamp(u_dehaze * 0.95 * dark, 0.0, 0.9);
      lin = (lin - t) / (1.0 - t);
      blurS = (blurS - t) / (1.0 - t);
    } else {
      float h = -u_dehaze * 0.55;
      lin = mix(lin, vec3(0.75), h);
      blurS = mix(blurS, vec3(0.75), h);
    }
    lin = max(lin, vec3(0.0));
  }

  // Shadows / highlights using a blurred local luminance (local tone mapping)
  if (u_shadows != 0.0 || u_highlights != 0.0) {
    float Lp = luma(lin);
    float Lb = luma(blurL);
    float pm = lin2srgb1(mix(Lp, Lb, 0.65));
    float wS = 1.0 - smoothstep(0.0, 0.55, pm);
    float wH = smoothstep(0.35, 1.0, pm);
    float stops = u_shadows * 1.7 * wS * wS + u_highlights * 1.5 * wH;
    lin *= exp2(stops);
    blurS *= exp2(stops);
  }

  vec3 p = lin2srgb(lin);

  // Clarity: mid-scale local contrast, weighted to midtones
  if (u_clarity != 0.0) {
    float detail = luma(p) - luma(lin2srgb(blurS));
    float L = clamp(luma(p), 0.0, 1.0);
    float mid = 1.0 - pow(2.0 * L - 1.0, 2.0);
    p += detail * u_clarity * 1.6 * mid;
  }

  // Whites / blacks
  vec3 pc = clamp(p, 0.0, 1.0);
  p += u_whites * 0.35 * pc * pc * pc;
  p += u_blacks * 0.22 * pow(1.0 - pc, vec3(3.0));
  p = clamp(p, 0.0, 1.0);

  // Contrast S-curve
  if (u_contrast > 0.0) {
    p = mix(p, p * p * (3.0 - 2.0 * p), u_contrast);
  } else if (u_contrast < 0.0) {
    p = mix(p, 0.5 - sin(asin(clamp(1.0 - 2.0 * p, -1.0, 1.0)) / 3.0), -u_contrast);
  }

  // Tone curve: master then per channel
  if (u_useCurve == 1) {
    vec3 q = p * (255.0 / 256.0) + 0.5 / 256.0;
    p = vec3(texture(u_curve, vec2(q.r, 0.125)).r, texture(u_curve, vec2(q.g, 0.125)).r, texture(u_curve, vec2(q.b, 0.125)).r);
    q = p * (255.0 / 256.0) + 0.5 / 256.0;
    p = vec3(texture(u_curve, vec2(q.r, 0.375)).r, texture(u_curve, vec2(q.g, 0.625)).r, texture(u_curve, vec2(q.b, 0.875)).r);
  }

  // HSL / Color mixer, or B&W mix
  vec3 hsv = rgb2hsv(clamp(p, 0.0, 1.0));
  float w[8];
  bandWeights(hsv.x * 360.0, w);
  if (u_bw == 1) {
    float mixv = 0.0;
    for (int i = 0; i < 8; i++) mixv += w[i] * u_hslLum[i];
    float g = luma(p) * (1.0 + mixv * hsv.y * 0.9);
    p = vec3(clamp(g, 0.0, 1.0));
  } else if (u_hsl == 1) {
    float dh = 0.0, ds = 0.0, dl = 0.0;
    for (int i = 0; i < 8; i++) { dh += w[i] * u_hslHue[i]; ds += w[i] * u_hslSat[i]; dl += w[i] * u_hslLum[i]; }
    hsv.x = fract(hsv.x + dh * 30.0 / 360.0 + 1.0);
    hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
    p = hsv2rgb(hsv);
    p *= 1.0 + dl * 0.6 * hsv.y;
  }

  // Vibrance & saturation
  float Y = luma(p);
  float sat = max(max(p.r, p.g), p.b) - min(min(p.r, p.g), p.b);
  float satAmt = 1.0 + u_saturation + u_vibrance * (1.0 - clamp(sat * 1.5, 0.0, 1.0)) + max(u_dehaze, 0.0) * 0.25;
  p = mix(vec3(Y), p, max(satAmt, 0.0));

  // Color grading (split toning)
  if (u_grade == 1) {
    float Lg = clamp(luma(p) - u_gradeBalance * 0.25, 0.0, 1.0);
    float wS = 1.0 - smoothstep(0.0, 0.55, Lg);
    float wH = smoothstep(0.45, 1.0, Lg);
    float wM = max(1.0 - wS - wH, 0.0);
    p += u_gradeS * wS + u_gradeM * wM + u_gradeH * wH;
  }

  // Vignette
  if (u_vignette != 0.0) {
    vec2 d = (v_uv - 0.5) * 2.0;
    float r = length(d) / 1.41421;
    float mid = mix(0.15, 0.95, u_vigMid);
    float f = mix(0.05, 0.8, u_vigFeather);
    float v = smoothstep(mid - f * 0.5, mid + f * 0.5, r);
    if (u_vignette < 0.0) p *= 1.0 + u_vignette * v;
    else p = mix(p, vec3(1.0), u_vignette * v);
  }

  // Film grain
  if (u_grain > 0.0) {
    vec2 gp = v_uv * u_size / (0.8 + u_grainSize * 3.0);
    float n = valueNoise(gp) * 0.6 + valueNoise(gp * 2.13 + 17.0) * 0.4 - 0.5;
    float L = clamp(luma(p), 0.0, 1.0);
    p += n * u_grain * 0.28 * (1.0 - 0.6 * abs(L - 0.5) * 2.0);
  }

  o = vec4(clamp(p, 0.0, 1.0), src.a);
}`;

// ---------------------------------------------------------------------------
// White balance model (shared by shader uniforms and the auto/picker tools).

export function wbMultipliers(temp, tint) {
  const t = temp / 100;
  const n = tint / 100;
  const r = Math.pow(2, 0.6 * t + 0.3 * n);
  const g = Math.pow(2, -0.6 * n);
  const b = Math.pow(2, -0.6 * t + 0.3 * n);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / y, g / y, b / y];
}

// Given an average linear RGB that should be neutral, return {temp, tint}.
export function wbFromNeutral(r, g, b) {
  r = Math.max(r, 1e-4);
  g = Math.max(g, 1e-4);
  b = Math.max(b, 1e-4);
  const a = Math.log2(r / b);
  const c = Math.log2(g / Math.sqrt(r * b));
  const t = clamp(-a / 1.2, -1, 1);
  const n = clamp(c / 0.9, -1, 1);
  return { temp: Math.round(t * 100), tint: Math.round(n * 100) };
}

function gradeVector(h, s) {
  if (!s) return [0, 0, 0];
  const [r, g, b] = hsvToRgb(h, 1, 1);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = (s / 100) * 0.22;
  return [(r - y) * k, (g - y) * k, (b - y) * k];
}

function uniformsFor(s, refW, refH) {
  const hsl = s.hsl;
  const g = s.grading;
  const hasHsl = hsl.hue.some(Boolean) || hsl.sat.some(Boolean) || hsl.lum.some(Boolean);
  const hasGrade = !!(g.shadows.s || g.midtones.s || g.highlights.s);
  return {
    u_size: [refW, refH],
    u_wb: wbMultipliers(s.temp, s.tint),
    u_exposure: Math.pow(2, s.exposure),
    u_contrast: s.contrast / 100,
    u_highlights: s.highlights / 100,
    u_shadows: s.shadows / 100,
    u_whites: s.whites / 100,
    u_blacks: s.blacks / 100,
    u_clarity: s.clarity / 100,
    u_dehaze: s.dehaze / 100,
    u_vibrance: s.vibrance / 100,
    u_saturation: s.saturation / 100,
    u_hslHue: hsl.hue.map((v) => v / 100),
    u_hslSat: hsl.sat.map((v) => v / 100),
    u_hslLum: hsl.lum.map((v) => v / 100),
    u_hsl: hasHsl ? 1 : 0,
    u_bw: s.bw ? 1 : 0,
    u_gradeS: gradeVector(g.shadows.h, g.shadows.s),
    u_gradeM: gradeVector(g.midtones.h, g.midtones.s),
    u_gradeH: gradeVector(g.highlights.h, g.highlights.s),
    u_gradeBalance: g.balance / 100,
    u_grade: hasGrade ? 1 : 0,
    u_sharpen: s.sharpen / 100,
    u_sharpenRadius: s.sharpenRadius,
    u_vignette: s.vignette / 100,
    u_vigMid: s.vignetteMidpoint / 100,
    u_vigFeather: s.vignetteFeather / 100,
    u_grain: s.grain / 100,
    u_grainSize: s.grainSize / 100,
  };
}

// Render `source` (canvas) with develop settings `s` into a new 2D canvas.
// `refW/refH` is the full-resolution size, used so grain looks the same at any preview scale.
export function renderDevelop(source, s, { refW = source.width, refH = source.height, target } = {}) {
  s = normalizeDevelop(s);
  const glr = getGL();
  const gl = glr.gl;
  const w = source.width;
  const h = source.height;
  if (w > glr.maxTexture || h > glr.maxTexture) {
    throw new Error(`Image is larger than this GPU supports (${glr.maxTexture}px).`);
  }
  const src = glr.texture(source, { mipmap: true });

  // Blur pyramid for local adjustments
  const sS = fitSize(w, h, 640);
  const sL = fitSize(w, h, 160);
  const dsS = glr.target(sS.w, sS.h);
  glr.pass(DOWNSAMPLE, { textures: { u_src: src }, out: dsS });
  const tmpS = glr.target(sS.w, sS.h);
  const sigS = 2.2;
  glr.pass(BLUR, { textures: { u_src: dsS }, uniforms: { u_dir: [1 / sS.w, 0], u_sigma: sigS }, out: tmpS });
  glr.pass(BLUR, { textures: { u_src: tmpS }, uniforms: { u_dir: [0, 1 / sS.h], u_sigma: sigS }, out: dsS });
  const dsL = glr.target(sL.w, sL.h);
  glr.pass(DOWNSAMPLE, { textures: { u_src: dsS }, out: dsL });
  const tmpL = glr.target(sL.w, sL.h);
  const sigL = 3.5;
  glr.pass(BLUR, { textures: { u_src: dsL }, uniforms: { u_dir: [1 / sL.w, 0], u_sigma: sigL }, out: tmpL });
  glr.pass(BLUR, { textures: { u_src: tmpL }, uniforms: { u_dir: [0, 1 / sL.h], u_sigma: sigL }, out: dsL });

  // Optional noise reduction pass
  let base = src;
  let nrTarget = null;
  if (s.noise > 0 || s.colorNoise > 0) {
    nrTarget = glr.target(w, h);
    glr.pass(DENOISE, {
      textures: { u_src: src },
      uniforms: { u_texel: [1 / w, 1 / h], u_nr: s.noise / 100, u_cnr: s.colorNoise / 100 },
      out: nrTarget,
    });
    base = nrTarget;
  }

  const useCurve = !(isIdentityCurve(s.curve.master) && isIdentityCurve(s.curve.r) && isIdentityCurve(s.curve.g) && isIdentityCurve(s.curve.b));
  const curveTex = glr.dataTexture(256, 4, curveTextureData(s.curve));

  const scale = w / refW;
  const uniforms = uniformsFor(s, refW, refH);
  uniforms.u_texel = [1 / w, 1 / h];
  uniforms.u_useCurve = useCurve ? 1 : 0;
  uniforms.u_sharpenRadius = Math.max(0.35, s.sharpenRadius * Math.min(1, scale * 1.5));
  if (scale < 0.5) uniforms.u_sharpen *= scale * 2;

  glr.pass(DEVELOP, {
    textures: { u_src: base, u_blurS: dsS, u_blurL: dsL, u_curve: curveTex },
    uniforms,
    w, h,
  });
  const out = glr.toCanvas(w, h, target && target.width === w && target.height === h ? target : null);
  glr.release(src, dsS, tmpS, dsL, tmpL, nrTarget, curveTex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return out;
}

// ---------------------------------------------------------------------------
// Auto tone & auto white balance

function srgbToLin(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linToSrgb(v) {
  v = Math.max(0, v);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function sampleData(source, maxEdge = 384) {
  const f = fitSize(source.width, source.height, maxEdge);
  const c = f.s < 1 ? resizeCanvas(source, f.w, f.h) : source;
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
}

export function autoWhiteBalance(source) {
  const d = sampleData(source);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const lr = srgbToLin(d[i] / 255);
    const lg = srgbToLin(d[i + 1] / 255);
    const lb = srgbToLin(d[i + 2] / 255);
    const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    if (y < 0.02 || mx > 250) continue; // skip near-black and clipped
    r += lr; g += lg; b += lb; n++;
  }
  if (!n) return { temp: 0, tint: 0 };
  return wbFromNeutral(r / n, g / n, b / n);
}

export function whiteBalanceFromPixel(source, x, y) {
  const g = source.getContext('2d', { willReadFrequently: true });
  const x0 = clamp(Math.round(x) - 2, 0, source.width - 1);
  const y0 = clamp(Math.round(y) - 2, 0, source.height - 1);
  const w = Math.min(5, source.width - x0);
  const h = Math.min(5, source.height - y0);
  const d = g.getImageData(x0, y0, w, h).data;
  let r = 0;
  let gg = 0;
  let b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += srgbToLin(d[i] / 255);
    gg += srgbToLin(d[i + 1] / 255);
    b += srgbToLin(d[i + 2] / 255);
  }
  return wbFromNeutral(r / n, gg / n, b / n);
}

export function autoTone(source, current) {
  const s = normalizeDevelop(current);
  const wb = wbMultipliers(s.temp, s.tint);
  const d = sampleData(source);
  const hist = new Uint32Array(256);
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const y = 0.2126 * srgbToLin(d[i] / 255) * wb[0] + 0.7152 * srgbToLin(d[i + 1] / 255) * wb[1] + 0.0722 * srgbToLin(d[i + 2] / 255) * wb[2];
    const p = linToSrgb(y);
    const bin = clamp(Math.round(p * 255), 0, 255);
    hist[bin]++;
    sum += p;
    sum2 += p * p;
    n++;
  }
  if (!n) return s;
  const pct = (q) => {
    const target = q * n;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };
  const median = pct(0.5);
  const lo = pct(0.005);
  const hi = pct(0.995);
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));

  const exposure = clamp(Math.log2(srgbToLin(0.46) / Math.max(srgbToLin(median), 1e-4)) * 0.75, -2.5, 2.5);
  const k = Math.pow(2, exposure);
  const hiAfter = linToSrgb(srgbToLin(hi) * k);
  const loAfter = linToSrgb(srgbToLin(lo) * k);
  const clipHi = hist.slice(250).reduce((a, b) => a + b, 0) / n;
  const clipLo = hist.slice(0, 4).reduce((a, b) => a + b, 0) / n;

  s.exposure = Math.round(exposure * 100) / 100;
  s.whites = Math.round(clamp((0.97 - hiAfter) * 160, -40, 60));
  s.blacks = Math.round(clamp((0.03 - loAfter) * 180 - clipLo * 100, -50, 40));
  s.highlights = Math.round(clamp(-20 - clipHi * 400 - Math.max(0, hiAfter - 0.9) * 120, -80, 0));
  s.shadows = Math.round(clamp(15 + Math.max(0, 0.25 - pct(0.2)) * 160, 0, 60));
  s.contrast = Math.round(clamp((0.22 - std) * 120, -20, 35));
  s.vibrance = Math.max(s.vibrance, 12);
  return s;
}

// ---------------------------------------------------------------------------
// Presets

function preset(name, values) {
  return { name, builtin: true, settings: values };
}

const FADE = [[0, 0.1], [0.25, 0.28], [0.75, 0.76], [1, 0.95]];

export const BUILTIN_PRESETS = [
  preset('Vivid', { vibrance: 35, saturation: 10, contrast: 18, clarity: 12 }),
  preset('Bright & Airy', { exposure: 0.35, contrast: -15, highlights: -30, shadows: 30, whites: 15, vibrance: 10, temp: 5 }),
  preset('Landscape Pop', { dehaze: 15, clarity: 25, vibrance: 30, highlights: -35, shadows: 30, hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 12, 0, 18, 0, 0], lum: [0, 0, 0, 0, 0, -10, 0, 0] } }),
  preset('Soft Portrait', { clarity: -20, contrast: -5, highlights: -20, shadows: 15, vibrance: 8, hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, -8, 0, 0, 0, 0, 0, 0], lum: [0, 12, 0, 0, 0, 0, 0, 0] } }),
  preset('Cinematic', { contrast: 15, saturation: -8, highlights: -20, shadows: 10, grading: { shadows: { h: 190, s: 40 }, midtones: { h: 40, s: 0 }, highlights: { h: 35, s: 35 }, balance: 0 }, vignette: -15 }),
  preset('Moody', { exposure: -0.3, contrast: 22, highlights: -40, shadows: -10, saturation: -22, temp: -10, vignette: -35, grading: { shadows: { h: 200, s: 25 }, midtones: { h: 40, s: 0 }, highlights: { h: 40, s: 10 }, balance: -10 } }),
  preset('Warm Sunset', { temp: 30, tint: 8, vibrance: 22, contrast: 10, grading: { shadows: { h: 280, s: 10 }, midtones: { h: 40, s: 0 }, highlights: { h: 30, s: 30 }, balance: 0 } }),
  preset('Cool Blue', { temp: -28, tint: -4, contrast: 8, grading: { shadows: { h: 215, s: 25 }, midtones: { h: 40, s: 0 }, highlights: { h: 200, s: 8 }, balance: 0 } }),
  preset('Matte', { contrast: -10, saturation: -10, curve: { master: FADE, r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } }),
  preset('Faded Film', { saturation: -20, grain: 22, temp: 6, curve: { master: FADE, r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0.06], [1, 0.94]] }, grading: { shadows: { h: 170, s: 15 }, midtones: { h: 40, s: 0 }, highlights: { h: 45, s: 15 }, balance: 0 } }),
  preset('Vintage', { temp: 15, tint: 6, saturation: -25, contrast: 8, grain: 28, vignette: -25, curve: { master: FADE, r: [[0, 0.04], [1, 1]], g: [[0, 0], [1, 0.97]], b: [[0, 0.1], [1, 0.85]] } }),
  preset('Black & White', { bw: true, contrast: 25, clarity: 15 }),
  preset('B&W High Contrast', { bw: true, contrast: 60, whites: 20, blacks: -30, clarity: 30, hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [10, 15, 10, -10, -20, -30, -10, 0] } }),
  preset('Sepia', { bw: true, contrast: 12, grading: { shadows: { h: 30, s: 25 }, midtones: { h: 35, s: 45 }, highlights: { h: 45, s: 20 }, balance: 0 }, vignette: -20 }),
  preset('Noir', { bw: true, contrast: 45, exposure: -0.25, blacks: -25, clarity: 20, vignette: -45, grain: 18 }),
];

export function applyPreset(presetSettings) {
  return normalizeDevelop({ ...defaultDevelop(), ...deepClone(presetSettings) });
}

// Render a small thumbnail of a source with settings (used for preset previews).
export function previewThumbnail(source, settings, maxEdge = 160) {
  const f = fitSize(source.width, source.height, maxEdge);
  const small = resizeCanvas(source, f.w, f.h);
  if (isIdentityDevelop(settings)) return small;
  return renderDevelop(small, settings, { refW: source.width, refH: source.height });
}

export { createCanvas };
