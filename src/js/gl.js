// Minimal WebGL2 compute helper used by the develop pipeline and filters.
// Textures are uploaded with FLIP_Y so every pass shares GL's bottom-left origin,
// and the final pass draws straight into the canvas which is then copied to 2D.

import { createCanvas } from './util.js';

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export class GLRunner {
  constructor() {
    this.canvas = createCanvas(16, 16);
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error('WebGL2 is not available on this computer.');
    this.gl = gl;
    this.programs = new Map();
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.quad = buf;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.lost = false;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }

  program(fragSrc) {
    let p = this.programs.get(fragSrc);
    if (p) return p;
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('Shader compile error: ' + log);
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Shader link error: ' + gl.getProgramInfoLog(prog));
    }
    const uniforms = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
    }
    p = { prog, uniforms };
    this.programs.set(fragSrc, p);
    return p;
  }

  // Upload a canvas/ImageBitmap as a texture.
  texture(source, { mipmap = false, flip = true } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    return { tex, w: source.width, h: source.height };
  }

  dataTexture(w, h, data) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return { tex, w, h };
  }

  target(w, h) {
    const gl = this.gl;
    const t = this.dataTexture(w, h, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    t.fbo = fbo;
    return t;
  }

  release(...items) {
    const gl = this.gl;
    for (const t of items) {
      if (!t) continue;
      if (t.fbo) gl.deleteFramebuffer(t.fbo);
      if (t.tex) gl.deleteTexture(t.tex);
    }
  }

  // Run a fragment shader. `textures` maps sampler names to texture objects.
  // `out` is a render target or null for the canvas (resized to w x h).
  pass(fragSrc, { textures = {}, uniforms = {}, out = null, w, h }) {
    const gl = this.gl;
    const { prog, uniforms: info } = this.program(fragSrc);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    if (out) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      gl.viewport(0, 0, out.w, out.h);
    } else {
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
    }
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) {
      const u = info[name];
      if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(u.loc, unit);
      unit++;
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const u = info[name];
      if (!u) continue;
      setUniform(gl, u, v);
    }
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Copy what was just drawn to the GL canvas into a fresh 2D canvas.
  toCanvas(w, h, target) {
    const out = target || createCanvas(w, h);
    const g = out.getContext('2d');
    g.clearRect(0, 0, out.width, out.height);
    g.drawImage(this.canvas, 0, 0, w, h, 0, 0, out.width, out.height);
    return out;
  }

  // Convenience: run a single-pass filter on a canvas and return a new canvas.
  filter(fragSrc, source, uniforms = {}, extraCanvases = {}) {
    const w = source.width;
    const h = source.height;
    const src = this.texture(source);
    const extras = {};
    for (const [k, c] of Object.entries(extraCanvases)) extras[k] = this.texture(c);
    this.pass(fragSrc, {
      textures: { u_src: src, ...extras },
      uniforms: { u_size: [w, h], u_texel: [1 / w, 1 / h], ...uniforms },
      w, h,
    });
    const out = this.toCanvas(w, h);
    this.release(src, ...Object.values(extras));
    return out;
  }
}

function setUniform(gl, u, v) {
  const loc = u.loc;
  switch (u.type) {
    case gl.FLOAT:
      if (u.size > 1) gl.uniform1fv(loc, v);
      else gl.uniform1f(loc, v);
      break;
    case gl.FLOAT_VEC2: gl.uniform2fv(loc, v); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(loc, v); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(loc, v); break;
    case gl.INT:
    case gl.BOOL:
      gl.uniform1i(loc, typeof v === 'boolean' ? (v ? 1 : 0) : v);
      break;
    default:
      gl.uniform1f(loc, v);
  }
}

let shared = null;
export function getGL() {
  if (!shared || shared.lost) shared = new GLRunner();
  return shared;
}

export const GLSL_COMMON = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgb2lin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float lin2srgb1(float c) {
  c = max(c, 0.0);
  return c < 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;
