// Layers panel, layer properties and history list.

import { app } from '../app.js';
import { el } from '../util.js';
import { iconButton, section, slider, selectField } from './widgets.js';
import { icon } from './icons.js';
import { histogramView } from './histogram.js';
import { BLEND_MODES } from '../document.js';
import { isIdentityDevelop } from '../develop.js';
import {
  commit, newLayer, deleteLayer, duplicateLayer, addMask,
} from '../ops.js';

function drawThumb(canvas, src, max = 40) {
  if (!src) return;
  const s = Math.min(max / src.width, (max * 0.8) / src.height);
  canvas.width = Math.max(1, Math.round(src.width * s));
  canvas.height = Math.max(1, Math.round(src.height * s));
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, canvas.width, canvas.height);
}

function drawMaskThumb(canvas, mask) {
  const s = Math.min(40 / mask.width, 32 / mask.height);
  canvas.width = Math.max(1, Math.round(mask.width * s));
  canvas.height = Math.max(1, Math.round(mask.height * s));
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.globalCompositeOperation = 'source-over';
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const tg = tmp.getContext('2d');
  tg.drawImage(mask, 0, 0, tmp.width, tmp.height);
  tg.globalCompositeOperation = 'source-in';
  tg.fillStyle = '#fff';
  tg.fillRect(0, 0, tmp.width, tmp.height);
  g.drawImage(tmp, 0, 0);
}

export function buildLayersPanel() {
  const blend = selectField({
    options: BLEND_MODES,
    value: 'source-over',
    onChange: (v) => {
      const l = app.doc && app.doc.active;
      if (!l) return;
      l.blend = v;
      commit('Blend Mode');
    },
  });
  const opacity = slider({
    label: 'Opacity', min: 0, max: 100, value: 100, def: 100, format: (v) => Math.round(v) + '%',
    onInput: (v) => { const l = app.doc && app.doc.active; if (l) { l.opacity = v / 100; app.render(); } },
    onCommit: () => commit('Opacity'),
  });
  const props = el('div', { class: 'layer-props' }, blend.select, el('div', {}), el('div', { style: { gridColumn: '1 / -1' } }, opacity));
  const list = el('div', { class: 'layer-list' });
  const toolbar = el('div', { class: 'layers-toolbar' },
    iconButton('sliders', 'Adjust this layer in Develop', () => app.setModule('develop')),
    iconButton('mask', 'Add layer mask (from selection if any)', () => addMask(true)),
    iconButton('copy', 'Duplicate layer (Ctrl+J)', () => duplicateLayer()),
    iconButton('plus', 'New layer (Ctrl+Shift+N)', () => newLayer()),
    iconButton('trash', 'Delete layer', () => deleteLayer()));

  let dragId = null;
  const rows = new Map();

  function build() {
    list.innerHTML = '';
    rows.clear();
    const d = app.doc;
    if (!d) return;
    const active = d.active;
    blend.set(active ? active.blend : 'source-over');
    opacity.set(active ? Math.round(active.opacity * 100) : 100);
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      const eye = iconButton(l.visible ? 'eye' : 'eyeOff', l.visible ? 'Hide layer' : 'Show layer', () => {
        l.visible = !l.visible;
        commit(l.visible ? 'Show Layer' : 'Hide Layer');
      });
      const thumbCanvas = el('canvas');
      const thumb = l.type === 'text'
        ? el('div', { class: 'layer-thumb text' + (!app.maskEditing && l === active ? ' selected' : '') }, 'T')
        : el('div', { class: 'layer-thumb' + (!app.maskEditing && l === active && l.mask ? ' selected' : '') }, thumbCanvas);
      let maskCanvas = null;
      let maskThumb = null;
      if (l.mask) {
        maskCanvas = el('canvas');
        maskThumb = el('div', { class: 'layer-thumb' + (app.maskEditing && l === active ? ' selected' : ''), title: 'Layer mask – click to paint on the mask, Shift+click to disable' }, maskCanvas);
        if (!l.maskEnabled) maskThumb.style.opacity = '0.4';
        maskThumb.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.shiftKey) {
            l.maskEnabled = !l.maskEnabled;
            commit(l.maskEnabled ? 'Enable Mask' : 'Disable Mask');
            return;
          }
          d.setActive(l);
          app.maskEditing = true;
          app.emit('mask-editing');
          build();
        });
        thumb.addEventListener('click', (e) => {
          e.stopPropagation();
          d.setActive(l);
          app.maskEditing = false;
          app.emit('mask-editing');
          build();
        });
      }
      const nameEl = el('div', { class: 'layer-name', title: 'Double-click to rename' }, l.name);
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = el('input', { type: 'text', value: l.name });
        nameEl.innerHTML = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();
        const done = (save) => {
          if (save && input.value.trim() && input.value !== l.name) {
            l.name = input.value.trim();
            commit('Rename Layer');
          } else build();
        };
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') done(true);
          if (ev.key === 'Escape') done(false);
        });
        input.addEventListener('blur', () => done(true));
      });
      const badges = el('div', { class: 'layer-badges' });
      if (l.type === 'raster' && !isIdentityDevelop(l.develop)) {
        const b = icon('sliders', 13);
        b.title = 'Has Develop adjustments';
        badges.appendChild(b);
      }
      if (l.linked) {
        const b = icon('link', 13);
        b.title = 'Linked to the Library photo';
        badges.appendChild(b);
      }
      const row = el('div', {
        class: 'layer-item' + (l === active ? ' active' : '') + (l.visible ? '' : ' hidden'),
        draggable: true,
      }, eye, thumb, maskThumb, nameEl, badges);
      row.addEventListener('click', () => {
        if (d.active !== l) {
          d.setActive(l);
          app.maskEditing = false;
          app.emit('mask-editing');
        }
        build();
      });
      row.addEventListener('dblclick', () => {
        if (l.type === 'text') app.setTool('text');
      });
      row.addEventListener('dragstart', (e) => {
        dragId = l.id;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', l.id);
      });
      row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); });
      row.addEventListener('dragover', (e) => {
        if (!dragId || dragId === l.id) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        row.classList.toggle('drop-above', above);
        row.classList.toggle('drop-below', !above);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-above', 'drop-below');
        const src = d.layers.find((x) => x.id === dragId);
        if (!src || src === l) return;
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        d.layers.splice(d.layers.indexOf(src), 1);
        const ti = d.layers.indexOf(l);
        d.layers.splice(above ? ti + 1 : ti, 0, src);
        d.structureVersion++;
        commit('Reorder Layers');
      });
      list.appendChild(row);
      rows.set(l, { thumbCanvas, maskCanvas });
    }
    drawThumbs();
  }

  let thumbTimer = null;
  function drawThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      for (const [l, r] of rows) {
        if (l.type === 'raster' && l.canvas) {
          const src = l._cache && l._cache.src === l.canvas ? l._cache.canvas : l.canvas;
          drawThumb(r.thumbCanvas, src);
        }
        if (r.maskCanvas && l.mask) drawMaskThumb(r.maskCanvas, l.mask);
      }
    }, 150);
  }

  let structKey = '';
  app.on('doc', () => { structKey = ''; build(); });
  app.on('mask-editing', () => build());
  app.on('doc-change', (d) => {
    if (d !== app.doc) return;
    const key = d.layers.map((l) => `${l.id}:${l.name}:${l.visible}:${l.blend}:${!!l.mask}:${l.maskEnabled}:${l.type}:${isIdentityDevelop(l.develop)}`).join('|') + '#' + d.activeId + app.maskEditing;
    if (key !== structKey) {
      structKey = key;
      build();
    } else {
      const active = d.active;
      if (active) opacity.set(Math.round(active.opacity * 100));
      drawThumbs();
    }
  });

  return el('div', { class: 'panel-stack', style: { flex: '1', minHeight: '0' } }, props, el('div', { class: 'panel-scroll' }, list), toolbar);
}

export function historyView() {
  const list = el('div', { class: 'history-list' });
  function build() {
    list.innerHTML = '';
    const d = app.doc;
    if (!d) return;
    d.history.forEach((s, i) => {
      const item = el('div', {
        class: 'history-item' + (i === d.historyIndex ? ' current' : i > d.historyIndex ? ' future' : ''),
      }, el('span', { class: 'num' }, String(i + 1)), el('span', {}, s.label));
      item.addEventListener('click', () => d.jumpTo(i));
      list.appendChild(item);
    });
    const cur = list.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  app.on('doc', build);
  app.on('doc-change', (d) => { if (d === app.doc) build(); });
  return list;
}

export function buildEditRight(container) {
  const layersBox = buildLayersPanel();
  const layersSection = section('Layers', layersBox, { id: 'edit-layers' });
  layersSection.classList.add('grow');
  const hist = el('div', { class: 'panel-scroll', style: { flex: 'none', maxHeight: '42%' } },
    section('Histogram', histogramView(), { id: 'edit-histo' }),
    section('History', historyView(), { id: 'edit-history', open: false }));
  const root = el('div', { class: 'panel-stack' }, hist, layersSection);
  container.appendChild(root);
  return root;
}
