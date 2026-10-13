// Text tool with on-canvas editing.

import { app } from '../app.js';
import { commit, newTextLayer } from '../ops.js';
import { layerBounds, textFont } from '../render.js';
import { el } from '../util.js';
import { selectField, numField, segmented, colorSwatch } from '../ui/widgets.js';

const FALLBACK_FONTS = [
  'Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free',
  'Lucida Console', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Sitka Text', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana',
];

let fontList = null;
async function loadFonts() {
  if (fontList) return fontList;
  fontList = FALLBACK_FONTS;
  try {
    if (window.queryLocalFonts) {
      const fonts = await window.queryLocalFonts();
      const fams = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      if (fams.length) fontList = fams;
    }
  } catch { /* permission denied */ }
  return fontList;
}

function activeText() {
  const l = app.doc && app.doc.active;
  return l && l.type === 'text' ? l : null;
}

export const textTool = {
  id: 'text', name: 'Text', key: 'T', icon: 'text', cursor: 'text', modules: ['edit'],
  editing: null,

  options(bar) {
    const l = activeText();
    const t = l ? l.text : { font: 'Segoe UI', size: 72, bold: false, italic: false, align: 'left', ...(app.lastTextStyle || {}) };
    const update = (patch, label = 'Text Style') => {
      app.lastTextStyle = { ...(app.lastTextStyle || {}), ...patch };
      const cur = activeText();
      if (!cur) return;
      Object.assign(cur.text, patch);
      if (this.editing) this.styleEditor();
      commit(label);
    };
    const fontSel = selectField({ label: 'Font', options: [t.font], value: t.font, onChange: (v) => update({ font: v }) });
    loadFonts().then((list) => {
      const sel = fontSel.select;
      sel.innerHTML = '';
      const all = list.includes(t.font) ? list : [t.font, ...list];
      for (const f of all) {
        const o = document.createElement('option');
        o.value = f;
        o.textContent = f;
        o.style.fontFamily = `"${f}"`;
        sel.appendChild(o);
      }
      sel.value = t.font;
    });
    bar.append(
      fontSel,
      numField({ label: 'Size', value: t.size, min: 1, max: 2000, onChange: (v) => update({ size: v }), suffix: 'px' }),
      segmented({
        options: [['b', 'B', 'Bold'], ['i', 'I', 'Italic']].map(([v, lab, tt]) => [v, lab, tt]),
        value: t.bold ? 'b' : t.italic ? 'i' : '',
        onChange: (v) => {
          const cur = activeText();
          const base = cur ? cur.text : t;
          update(v === 'b' ? { bold: !base.bold } : { italic: !base.italic });
          app.emit('tool-options');
        },
        cls: 'toggles',
      }),
      segmented({ options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], value: t.align, onChange: (v) => update({ align: v }) }),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Color'),
        colorSwatch({ value: l ? l.text.color : app.fg, onChange: (v) => { app.fg = v; app.emit('colors'); update({ color: v }, 'Text Color'); } })),
      el('span', { class: 'hint' }, 'Click to add text · click existing text to edit · Esc to finish'),
    );
  },

  onDown(e, p) {
    const d = app.doc;
    if (this.editing) {
      this.finish();
      return;
    }
    // hit an existing text layer?
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      if (l.type !== 'text' || !l.visible) continue;
      const b = layerBounds(l);
      if (p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h) {
        d.setActive(l);
        this.startEditing(l);
        return;
      }
    }
    const size = Math.max(12, Math.round(Math.min(d.width, d.height) / 14));
    const l = newTextLayer(p.x, p.y - size * 0.6, '');
    l.text.text = '';
    this.startEditing(l, true);
  },

  startEditing(layer, isNew = false) {
    this.editing = { layer, original: layer.text.text, isNew };
    app.hiddenLayers = new Set([layer]);
    const ta = el('textarea', { class: 'text-editor', spellcheck: false });
    ta.value = layer.text.text;
    this.ta = ta;
    app.view.container.appendChild(ta);
    this.styleEditor();
    ta.addEventListener('input', () => {
      layer.text.text = ta.value;
      layer.name = (ta.value.split('\n')[0] || 'Text').slice(0, 30);
      this.styleEditor();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
        e.preventDefault();
        this.finish();
      }
    });
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
    app.emit('tool-options');
    app.render();
  },

  styleEditor() {
    if (!this.editing || !this.ta) return;
    const l = this.editing.layer;
    const t = l.text;
    const v = app.view.view;
    const s = app.view.docToScreen(l.x, l.y);
    const ta = this.ta;
    ta.style.left = s.x + 'px';
    ta.style.top = s.y + 'px';
    ta.style.font = textFont(t, v.zoom);
    ta.style.lineHeight = t.size * t.lineHeight * v.zoom + 'px';
    ta.style.color = t.color;
    ta.style.textAlign = t.align;
    ta.style.paddingTop = t.size * 0.08 * v.zoom + 'px';
    ta.style.height = '0px';
    ta.style.width = '0px';
    ta.style.width = Math.max(40, ta.scrollWidth + t.size * v.zoom * 0.6) + 'px';
    ta.style.height = Math.max(t.size * v.zoom * 1.3, ta.scrollHeight) + 'px';
  },

  finish() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    app.hiddenLayers = null;
    if (this.ta) { this.ta.remove(); this.ta = null; }
    const l = ed.layer;
    const d = app.doc;
    if (!l.text.text.trim()) {
      d.removeLayer(l);
      commit(ed.isNew ? 'Cancel Text' : 'Delete Text Layer');
    } else if (l.text.text !== ed.original || ed.isNew) {
      commit('Edit Text');
    }
    app.render();
    app.emit('tool-options');
  },

  deactivate() {
    this.finish();
  },

  drawOverlay(g, view) {
    if (this.editing) {
      this.styleEditor();
      return;
    }
    const l = activeText();
    if (!l) return;
    const b = layerBounds(l);
    const a = view.docToScreen(b.x, b.y);
    const c = view.docToScreen(b.x + b.w, b.y + b.h);
    g.strokeStyle = 'rgba(80,160,255,0.9)';
    g.setLineDash([3, 3]);
    g.strokeRect(a.x + 0.5, a.y + 0.5, c.x - a.x, c.y - a.y);
  },
};
