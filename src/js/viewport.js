// The canvas viewport: zoom/pan, drawing the composited document and overlays,
// and routing pointer input to the active tool.

import { app } from './app.js';
import { Compositor } from './render.js';
import { selectionOutline } from './selection.js';
import { clamp, createCanvas } from './util.js';

export class Viewport {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewport-canvas';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.compositor = new Compositor();
    this.composite = null;
    this.compositeScale = 1;
    this.contentDirty = true;
    this.frameQueued = false;
    this.antsOffset = 0;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = window.devicePixelRatio || 1;
    this.pointer = null; // last pointer position in doc coords
    this.screenPointer = null;
    this.spaceDown = false;
    this.panning = null;
    this.toolActive = false;
    this.checker = this.makeChecker();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindInput();
    setInterval(() => {
      if (app.doc && app.doc.selection && app.module !== 'library') {
        this.antsOffset = (this.antsOffset + 1) % 16;
        this.requestFrame();
      }
    }, 90);
  }

  makeChecker() {
    const c = createCanvas(16, 16);
    const g = c.getContext('2d');
    g.fillStyle = '#cfcfcf';
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#9c9c9c';
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    return this.ctx.createPattern(c, 'repeat');
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
    this.invalidate();
    if (app.doc) app.emit('zoom', this.view.zoom);
  }

  // ---- view state ----

  get view() {
    const d = app.doc;
    if (!d) return { zoom: 1, cx: 0, cy: 0 };
    if (!d.view || (d.view.fitted && (d.view.fitW !== this.cssW || d.view.fitH !== this.cssH))) d.view = this.fitView(d);
    return d.view;
  }

  fitView(d) {
    const pad = 40;
    const z = Math.min((this.cssW - pad) / d.width, (this.cssH - pad) / d.height, 1);
    return { zoom: Math.max(z, 0.01), cx: d.width / 2, cy: d.height / 2, fitted: true, fitW: this.cssW, fitH: this.cssH };
  }

  fit() {
    if (!app.doc) return;
    app.doc.view = this.fitView(app.doc);
    this.afterZoom();
  }

  setZoom(z, anchorScreen) {
    const v = this.view;
    z = clamp(z, 0.01, 32);
    if (anchorScreen) {
      const before = this.screenToDoc(anchorScreen.x, anchorScreen.y);
      v.zoom = z;
      const after = this.screenToDoc(anchorScreen.x, anchorScreen.y);
      v.cx += before.x - after.x;
      v.cy += before.y - after.y;
    } else {
      v.zoom = z;
    }
    v.fitted = false;
    this.afterZoom();
  }

  zoomBy(f, anchor) {
    const steps = [0.01, 0.02, 0.03, 0.05, 0.0667, 0.0833, 0.125, 0.1667, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32];
    const z = this.view.zoom;
    let nz;
    if (f > 1) nz = steps.find((s) => s > z * 1.001) || 32;
    else nz = [...steps].reverse().find((s) => s < z / 1.001) || 0.01;
    this.setZoom(nz, anchor);
  }

  afterZoom() {
    this.invalidate();
    app.emit('zoom', this.view.zoom);
  }

  docToScreen(x, y) {
    const v = this.view;
    return { x: (x - v.cx) * v.zoom + this.cssW / 2, y: (y - v.cy) * v.zoom + this.cssH / 2 };
  }

  screenToDoc(x, y) {
    const v = this.view;
    return { x: (x - this.cssW / 2) / v.zoom + v.cx, y: (y - this.cssH / 2) / v.zoom + v.cy };
  }

  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- rendering ----

  invalidate() {
    this.contentDirty = true;
    this.requestFrame();
  }

  requestFrame() {
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      this.draw();
    });
  }

  displayScale() {
    const z = this.view.zoom * this.dpr;
    const s = Math.pow(2, Math.ceil(Math.log2(Math.max(z, 1 / 64))));
    return Math.min(1, s);
  }

  renderComposite() {
    const d = app.doc;
    const s = this.displayScale();
    this.composite = this.compositor.render(d, s, { before: app.before, previews: app.previews, hidden: app.hiddenLayers });
    this.compositeScale = s;
    this.contentDirty = false;
    app.emit('rendered', this.composite);
  }

  draw() {
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = getComputedStyle(this.container).getPropertyValue('--canvas-bg') || '#151517';
    g.fillRect(0, 0, this.cssW, this.cssH);
    const d = app.doc;
    if (!d || app.module === 'library') return;
    if (this.contentDirty) {
      try {
        this.renderComposite();
      } catch (err) {
        console.error(err);
        this.contentDirty = false;
      }
    }
    const v = this.view;
    const tl = this.docToScreen(0, 0);
    const w = d.width * v.zoom;
    const h = d.height * v.zoom;
    // drop shadow + checkerboard for transparency
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 18;
    g.fillStyle = this.checker;
    g.fillRect(tl.x, tl.y, w, h);
    g.restore();
    if (this.composite) {
      const pixelZoom = v.zoom / this.compositeScale;
      g.imageSmoothingEnabled = pixelZoom < 2;
      g.imageSmoothingQuality = 'high';
      g.drawImage(this.composite, tl.x, tl.y, w, h);
    }
    // selection
    if (d.selection && app.module !== 'library') this.drawAnts(g, d.selection);
    // tool overlay
    const tool = app.tool;
    if (tool && tool.drawOverlay) {
      g.save();
      tool.drawOverlay(g, this);
      g.restore();
    }
    if (app.before) {
      g.font = '600 12px "Segoe UI", sans-serif';
      const label = 'BEFORE';
      const tw = g.measureText(label).width + 16;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(12, 12, tw, 22);
      g.fillStyle = '#fff';
      g.fillText(label, 20, 27);
    }
  }

  drawAnts(g, sel) {
    const segs = selectionOutline(sel);
    if (!segs.length) return;
    const v = this.view;
    g.save();
    g.beginPath();
    const ox = this.cssW / 2 - v.cx * v.zoom;
    const oy = this.cssH / 2 - v.cy * v.zoom;
    const z = v.zoom;
    for (let i = 0; i < segs.length; i += 4) {
      g.moveTo(Math.round(segs[i] * z + ox) + 0.5, Math.round(segs[i + 1] * z + oy) + 0.5);
      g.lineTo(Math.round(segs[i + 2] * z + ox) + 0.5, Math.round(segs[i + 3] * z + oy) + 0.5);
    }
    g.lineWidth = 1;
    g.strokeStyle = '#000';
    g.setLineDash([]);
    g.stroke();
    g.strokeStyle = '#fff';
    g.setLineDash([4, 4]);
    g.lineDashOffset = -this.antsOffset;
    g.stroke();
    g.restore();
  }

  // Read the composite color at a document point.
  sampleColor(x, y) {
    if (!this.composite) return null;
    const s = this.compositeScale;
    const px = clamp(Math.floor(x * s), 0, this.composite.width - 1);
    const py = clamp(Math.floor(y * s), 0, this.composite.height - 1);
    const d = this.composite.getContext('2d').getImageData(px, py, 1, 1).data;
    return d;
  }

  // ---- input ----

  bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.screenPointer = null;
      this.requestFrame();
      app.emit('pointer', null);
    });
    c.addEventListener('dblclick', (e) => {
      const tool = app.tool;
      if (tool && tool.onDblClick && app.doc) tool.onDblClick(e, this.docPointFromEvent(e), this);
    });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) {
        if (!this.spaceDown) {
          this.spaceDown = true;
          this.updateCursor();
        }
        if (document.activeElement === c || document.activeElement === document.body) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
      }
    });
    window.addEventListener('blur', () => { this.spaceDown = false; });
  }

  docPointFromEvent(e) {
    const p = this.eventPoint(e);
    return this.screenToDoc(p.x, p.y);
  }

  onDown(e) {
    if (!app.doc || app.module === 'library') return;
    c_focus(this.canvas);
    const sp = this.eventPoint(e);
    if (e.button === 1 || this.spaceDown || (app.toolId === 'hand' && e.button === 0)) {
      this.panning = { x: sp.x, y: sp.y, cx: this.view.cx, cy: this.view.cy };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    const tool = app.tool;
    if (!tool || !tool.onDown) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.toolActive = true;
    const p = this.screenToDoc(sp.x, sp.y);
    try {
      tool.onDown(e, p, this);
    } catch (err) {
      console.error(err);
      app.status('Error: ' + err.message);
    }
    this.requestFrame();
  }

  onMove(e) {
    const sp = this.eventPoint(e);
    this.screenPointer = sp;
    if (!app.doc) return;
    const p = this.screenToDoc(sp.x, sp.y);
    this.pointer = p;
    app.emit('pointer', p);
    if (this.panning) {
      const v = this.view;
      v.cx = this.panning.cx - (sp.x - this.panning.x) / v.zoom;
      v.cy = this.panning.cy - (sp.y - this.panning.y) / v.zoom;
      v.fitted = false;
      this.requestFrame();
      return;
    }
    const tool = app.tool;
    if (this.toolActive && tool && tool.onMove) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const q = this.screenToDoc(...Object.values(this.eventPoint(ev)));
        try { tool.onMove(ev, q, this); } catch (err) { console.error(err); }
      }
    } else if (tool && tool.onHover) {
      tool.onHover(e, p, this);
    }
    this.requestFrame();
  }

  onUp(e) {
    if (this.panning) {
      this.panning = null;
      this.updateCursor();
      return;
    }
    if (!this.toolActive) return;
    this.toolActive = false;
    const tool = app.tool;
    const p = this.docPointFromEvent(e);
    if (tool && tool.onUp) {
      try { tool.onUp(e, p, this); } catch (err) { console.error(err); app.status('Error: ' + err.message); }
    }
    this.requestFrame();
  }

  onWheel(e) {
    if (!app.doc || app.module === 'library') return;
    e.preventDefault();
    const sp = this.eventPoint(e);
    if (e.shiftKey && !e.ctrlKey) {
      const v = this.view;
      v.cx += e.deltaY / v.zoom;
      v.cy += e.deltaX / v.zoom;
      this.requestFrame();
      return;
    }
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    this.setZoom(this.view.zoom * f, sp);
  }

  updateCursor() {
    let cur = 'default';
    if (this.spaceDown || app.toolId === 'hand') cur = 'grab';
    else if (app.tool && app.tool.cursor) cur = typeof app.tool.cursor === 'function' ? app.tool.cursor() : app.tool.cursor;
    this.canvas.style.cursor = cur;
  }

  // Brush outline helper for tools
  drawBrushCursor(g, size, extra) {
    if (!this.screenPointer || this.spaceDown) return;
    const r = Math.max(1, (size / 2) * this.view.zoom);
    const { x, y } = this.screenPointer;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 3;
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 1;
    g.stroke();
    if (extra) extra(g, x, y, r);
    if (r < 4) {
      g.beginPath();
      g.moveTo(x - 6, y); g.lineTo(x + 6, y);
      g.moveTo(x, y - 6); g.lineTo(x, y + 6);
      g.stroke();
    }
  }
}

function c_focus(el) {
  if (document.activeElement && document.activeElement !== el && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    document.activeElement.blur();
  }
}

export function isTyping(e) {
  const t = e.target;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA') return true;
  if (t.tagName === 'INPUT') {
    const type = (t.type || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'color'].includes(type);
  }
  return t.tagName === 'SELECT';
}
