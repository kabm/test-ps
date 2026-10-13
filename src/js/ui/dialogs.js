// Modal dialogs.

import { app } from '../app.js';
import { el, clamp, createCanvas, formatBytes } from '../util.js';
import { slider, checkField, selectField, button, segmented } from './widgets.js';
import { FILTERS, defaultsFor } from '../filters.js';
import { selectionForLayer } from '../selection.js';
import { commit, resizeImage, resizeCanvasOp, feather, growShrink } from '../ops.js';
import { newDocument, exportDoc, EXPORT_FORMATS, encodeForExport } from '../commands.js';
import { pickSavePath, pickDirectory, joinPath, writeFile, stripExt, baseName, appInfo, isDesktop } from '../platform.js';

let openModals = 0;
export function isModalOpen() {
  return openModals > 0;
}

export function modal({ title, body, buttons = [], width, onClose, footLeft }) {
  const root = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'backdrop' });
  const head = el('div', { class: 'modal-head' }, el('span', {}, title));
  const bodyEl = el('div', { class: 'modal-body' }, body);
  const foot = el('div', { class: 'modal-foot' }, footLeft ? el('div', { class: 'left' }, footLeft) : null);
  const box = el('div', { class: 'modal', style: width ? { width: width + 'px' } : {} }, head, bodyEl, foot);
  backdrop.appendChild(box);
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    openModals--;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose(result);
  };
  const btnEls = buttons.map((b) => {
    const be = button({
      label: b.label, cls: b.primary ? 'primary' : '',
      onClick: async () => {
        if (b.onClick) {
          const r = await b.onClick();
          if (r === false) return;
        }
        close(b.value ?? b.label);
      },
    });
    foot.appendChild(be);
    return be;
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const cancel = buttons.find((b) => b.cancel);
      if (cancel && cancel.onClick) cancel.onClick();
      close(null);
    } else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
      const primary = btnEls[buttons.findIndex((b) => b.primary)];
      if (primary) {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        setTimeout(() => primary.click(), 0);
      }
    } else {
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onKey, true);
  // drag by header
  head.addEventListener('pointerdown', (e) => {
    const r = box.getBoundingClientRect();
    const ox = e.clientX - r.left;
    const oy = e.clientY - r.top;
    box.style.position = 'fixed';
    box.style.margin = '0';
    const move = (ev) => {
      box.style.left = clamp(ev.clientX - ox, 0, window.innerWidth - 80) + 'px';
      box.style.top = clamp(ev.clientY - oy, 0, window.innerHeight - 40) + 'px';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  root.appendChild(backdrop);
  openModals++;
  setTimeout(() => {
    const f = box.querySelector('input:not([type=range]):not([type=checkbox]), select');
    if (f) { f.focus(); if (f.select) f.select(); }
  }, 30);
  return { close, box, body: bodyEl };
}

export function numberPrompt({ title, label, value, min, max, step = 1, unit = '' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'number', value, min, max, step, style: { width: '100px' } });
    let result = null;
    modal({
      title,
      body: el('div', { class: 'form-grid' }, el('label', {}, label), el('div', {}, input, ' ', unit)),
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: 'OK', primary: true, onClick: () => { result = clamp(parseFloat(input.value) || 0, min, max); } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function textPrompt({ title, label, value = '' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, style: { width: '260px' } });
    let result = null;
    modal({
      title,
      body: el('div', { class: 'form-grid' }, el('label', {}, label), input),
      buttons: [
        { label: 'Cancel', cancel: true },
        { label: 'OK', primary: true, onClick: () => { result = input.value.trim() || null; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function alertDialog(title, message) {
  modal({ title, body: el('div', { style: { maxWidth: '420px', whiteSpace: 'pre-wrap' } }, message), buttons: [{ label: 'OK', primary: true }] });
}

// ---------------------------------------------------------------------------

const SIZE_PRESETS = [
  ['1920 × 1080 (HD)', 1920, 1080], ['3840 × 2160 (4K)', 3840, 2160], ['1080 × 1080 (Square)', 1080, 1080],
  ['1080 × 1350 (Portrait post)', 1080, 1350], ['1080 × 1920 (Story)', 1080, 1920], ['A4 300 dpi', 2480, 3508],
  ['1200 × 628 (Banner)', 1200, 628], ['800 × 600', 800, 600],
];

export function newDocDialog() {
  const w = el('input', { type: 'number', value: app.prefs.lastNewW || 1920, min: 1, max: 16000 });
  const h = el('input', { type: 'number', value: app.prefs.lastNewH || 1080, min: 1, max: 16000 });
  const name = el('input', { type: 'text', value: 'Untitled' });
  let bg = 'white';
  const bgSel = segmented({ options: [['white', 'White'], ['black', 'Black'], ['transparent', 'Transparent'], ['fg', 'Foreground']], value: bg, onChange: (v) => { bg = v; } });
  const presets = el('div', { class: 'preset-sizes' }, SIZE_PRESETS.map(([l, pw, ph]) => {
    const b = el('button', { class: 'btn' }, l);
    b.addEventListener('click', () => { w.value = pw; h.value = ph; });
    return b;
  }));
  modal({
    title: 'New Document',
    width: 480,
    body: [
      el('div', { class: 'form-grid' },
        el('label', {}, 'Name'), name,
        el('label', {}, 'Width'), el('div', {}, w, ' px'),
        el('label', {}, 'Height'), el('div', {}, h, ' px'),
        el('label', {}, 'Background'), bgSel),
      el('div', { class: 'sub-label' }, 'Presets'),
      presets,
    ],
    buttons: [
      { label: 'Cancel', cancel: true },
      {
        label: 'Create', primary: true, onClick: () => {
          const W = clamp(parseInt(w.value, 10) || 1, 1, 16000);
          const H = clamp(parseInt(h.value, 10) || 1, 1, 16000);
          app.prefs.lastNewW = W;
          app.prefs.lastNewH = H;
          const fill = bg === 'white' ? '#ffffff' : bg === 'black' ? '#000000' : bg === 'fg' ? app.fg : null;
          newDocument({ width: W, height: H, fill, name: name.value || 'Untitled' });
          app.setModule('edit');
        },
      },
    ],
  });
}

export function imageSizeDialog() {
  const d = app.doc;
  if (!d) return;
  const ratio = d.width / d.height;
  let lock = true;
  const w = el('input', { type: 'number', value: d.width, min: 1, max: 16000 });
  const h = el('input', { type: 'number', value: d.height, min: 1, max: 16000 });
  const pct = el('input', { type: 'number', value: 100, min: 1, max: 1000 });
  const lockEl = checkField({ label: 'Keep proportions', value: true, onChange: (v) => { lock = v; } });
  w.addEventListener('input', () => {
    if (lock) h.value = Math.round(w.value / ratio);
    pct.value = Math.round((w.value / d.width) * 1000) / 10;
  });
  h.addEventListener('input', () => {
    if (lock) w.value = Math.round(h.value * ratio);
    pct.value = Math.round((h.value / d.height) * 1000) / 10;
  });
  pct.addEventListener('input', () => {
    w.value = Math.round((d.width * pct.value) / 100);
    h.value = lock ? Math.round(w.value / ratio) : Math.round((d.height * pct.value) / 100);
  });
  modal({
    title: 'Image Size',
    body: [
      el('div', { class: 'note' }, `Current size: ${d.width} × ${d.height} px`),
      el('div', { class: 'form-grid' },
        el('label', {}, 'Width'), el('div', {}, w, ' px'),
        el('label', {}, 'Height'), el('div', {}, h, ' px'),
        el('label', {}, 'Scale'), el('div', {}, pct, ' %')),
      lockEl,
    ],
    buttons: [
      { label: 'Cancel', cancel: true },
      { label: 'OK', primary: true, onClick: () => { resizeImage(parseInt(w.value, 10), parseInt(h.value, 10)); app.view.fit(); } },
    ],
  });
}

export function canvasSizeDialog() {
  const d = app.doc;
  if (!d) return;
  const w = el('input', { type: 'number', value: d.width, min: 1, max: 16000 });
  const h = el('input', { type: 'number', value: d.height, min: 1, max: 16000 });
  let anchor = [0.5, 0.5];
  const grid = el('div', { class: 'anchor-grid' });
  const btns = [];
  for (const ay of [0, 0.5, 1]) {
    for (const ax of [0, 0.5, 1]) {
      const b = el('button', { class: ax === 0.5 && ay === 0.5 ? 'active' : '' });
      b.addEventListener('click', () => { anchor = [ax, ay]; btns.forEach((x) => x.classList.remove('active')); b.classList.add('active'); });
      btns.push(b);
      grid.appendChild(b);
    }
  }
  let fill = 'transparent';
  const fillSel = selectField({ options: [['transparent', 'Transparent'], ['bg', 'Background color'], ['#ffffff', 'White'], ['#000000', 'Black']], value: fill, onChange: (v) => { fill = v; } });
  modal({
    title: 'Canvas Size',
    body: [
      el('div', { class: 'note' }, `Current size: ${d.width} × ${d.height} px`),
      el('div', { class: 'form-grid' },
        el('label', {}, 'Width'), el('div', {}, w, ' px'),
        el('label', {}, 'Height'), el('div', {}, h, ' px'),
        el('label', {}, 'Anchor'), grid,
        el('label', {}, 'Extension'), fillSel),
    ],
    buttons: [
      { label: 'Cancel', cancel: true },
      {
        label: 'OK', primary: true, onClick: () => {
          const f = fill === 'transparent' ? null : fill === 'bg' ? app.bg : fill;
          resizeCanvasOp(parseInt(w.value, 10), parseInt(h.value, 10), anchor, f);
          app.view.fit();
        },
      },
    ],
  });
}

export async function featherDialog() {
  if (!app.doc || !app.doc.selection) { app.status('Make a selection first.'); return; }
  const r = await numberPrompt({ title: 'Feather Selection', label: 'Feather radius', value: 10, min: 0.5, max: 500, step: 0.5, unit: 'px' });
  if (r) feather(r);
}

export async function growDialog(dir) {
  if (!app.doc || !app.doc.selection) { app.status('Make a selection first.'); return; }
  const r = await numberPrompt({ title: dir > 0 ? 'Expand Selection' : 'Contract Selection', label: dir > 0 ? 'Expand by' : 'Contract by', value: 8, min: 1, max: 500, unit: 'px' });
  if (r) growShrink(dir * r);
}

// ---------------------------------------------------------------------------
// Export

function exportControls(defaults = {}) {
  const state = { format: defaults.format || app.prefs.exportFormat || 'jpeg', quality: defaults.quality ?? app.prefs.exportQuality ?? 92, maxEdge: defaults.maxEdge ?? 0 };
  const qual = slider({ label: 'Quality', min: 10, max: 100, value: state.quality, def: 92, format: (v) => Math.round(v) + '%', onInput: (v) => { state.quality = v; } });
  const fmt = segmented({
    options: Object.entries(EXPORT_FORMATS).map(([k, v]) => [k, v.label]),
    value: state.format,
    onChange: (v) => { state.format = v; qual.style.display = v === 'png' || v === 'tiff' ? 'none' : ''; },
  });
  qual.style.display = state.format === 'png' || state.format === 'tiff' ? 'none' : '';
  const sizeSel = selectField({
    options: [[0, 'Original size'], [4096, 'Long edge 4096 px'], [3000, 'Long edge 3000 px'], [2048, 'Long edge 2048 px (web)'], [1600, 'Long edge 1600 px'], [1080, 'Long edge 1080 px (social)'], [800, 'Long edge 800 px']],
    value: state.maxEdge,
    onChange: (v) => { state.maxEdge = parseInt(v, 10); },
  });
  const node = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    el('div', { class: 'form-grid' }, el('label', {}, 'Format'), fmt, el('label', {}, 'Size'), sizeSel),
    qual);
  return { node, state };
}

export function exportDialog(d = app.doc) {
  if (!d) return;
  const { node, state } = exportControls();
  const est = el('div', { class: 'note' }, `${d.width} × ${d.height} px · ${d.layers.length} layer${d.layers.length === 1 ? '' : 's'} (flattened on export)`);
  modal({
    title: 'Export Image',
    width: 440,
    body: [node, est],
    buttons: [
      { label: 'Cancel', cancel: true },
      {
        label: 'Export…', primary: true, onClick: async () => {
          const f = EXPORT_FORMATS[state.format];
          app.prefs.exportFormat = state.format;
          app.prefs.exportQuality = state.quality;
          const path = await pickSavePath({ title: 'Export', defaultName: stripExt(d.name) + '.' + f.ext, filters: [{ name: f.label, extensions: [f.ext] }] });
          if (!path) return false;
          app.emit('busy', true, 'Exporting…');
          try {
            const size = await exportDoc(d, { format: state.format, quality: state.quality / 100, maxEdge: state.maxEdge }, path);
            app.status(`Exported ${baseName(path.replace('::download::', ''))} (${formatBytes(size)})`);
          } catch (e) {
            alertDialog('Export failed', e.message);
          } finally {
            app.emit('busy', false);
          }
          return true;
        },
      },
    ],
  });
}

export function batchExportDialog(entries) {
  if (!entries.length) { app.status('Select photos in the Library to export.'); return; }
  const { node, state } = exportControls({ maxEdge: 0 });
  let suffix = '';
  const suffixInput = el('input', { type: 'text', value: '', placeholder: 'e.g. -edit', style: { width: '120px' } });
  suffixInput.addEventListener('input', () => { suffix = suffixInput.value; });
  const progress = el('div', { class: 'progress' }, el('div'));
  const status = el('div', { class: 'note' }, `${entries.length} photo${entries.length === 1 ? '' : 's'} selected – develop settings are applied.`);
  let running = false;
  modal({
    title: 'Export Photos',
    width: 460,
    body: [node, el('div', { class: 'form-grid' }, el('label', {}, 'File name suffix'), suffixInput), status, progress],
    buttons: [
      { label: 'Close', cancel: true },
      {
        label: 'Choose Folder & Export', primary: true, onClick: async () => {
          if (running) return false;
          const dir = await pickDirectory('Export to folder');
          if (!dir) return false;
          running = true;
          const f = EXPORT_FORMATS[state.format];
          let done = 0;
          let failed = 0;
          for (const e of entries) {
            status.textContent = `Exporting ${e.name}… (${done + 1}/${entries.length})`;
            try {
              const canvas = await app.catalog.renderFull(e);
              const blob = await encodeForExport(canvas, { format: state.format, quality: state.quality / 100, maxEdge: state.maxEdge });
              await writeFile(joinPath(dir, stripExt(e.name) + suffix + '.' + f.ext), blob);
            } catch (err) {
              console.error(err);
              failed++;
            }
            done++;
            progress.firstChild.style.width = (done / entries.length) * 100 + '%';
          }
          running = false;
          status.textContent = `Done: ${done - failed} exported${failed ? `, ${failed} failed` : ''}.`;
          app.status(status.textContent);
          return false;
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Filters with live preview

export function filterDialog(id) {
  const d = app.doc;
  const f = FILTERS[id];
  if (!d || !f) return;
  const l = d.active;
  if (!l || l.type !== 'raster') { app.status('Filters work on pixel layers. Rasterize text layers first.'); return; }
  const isMask = app.maskEditing && l.mask;
  const values = { ...defaultsFor(id), ...(app.prefs.filterValues?.[id] || {}) };
  const original = isMask ? l.mask : l.canvas;
  const sel = selectionForLayer(d, l);
  let previewOn = true;
  let version = 0;

  const compute = () => {
    let out = f.run(original, values);
    if (sel) {
      const c = createCanvas(original.width, original.height);
      const g = c.getContext('2d');
      g.drawImage(original, 0, 0);
      const t = createCanvas(original.width, original.height);
      const tg = t.getContext('2d');
      tg.drawImage(out, 0, 0);
      tg.globalCompositeOperation = 'destination-in';
      tg.drawImage(sel, 0, 0);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(sel, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.drawImage(t, 0, 0);
      out = c;
    }
    return out;
  };
  let timer = null;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!previewOn || isMask) { app.previews.delete(l); app.render(); return; }
      try {
        app.previews.set(l, { canvas: compute(), version: ++version });
      } catch (e) { console.error(e); }
      app.render();
    }, 40);
  };
  const body = [];
  for (const p of f.params) {
    if (p.type === 'bool') {
      body.push(checkField({ label: p.label, value: values[p.key], onChange: (v) => { values[p.key] = v; update(); } }));
    } else {
      body.push(slider({
        label: p.label, min: p.min, max: p.max, step: p.step, value: values[p.key], def: p.def,
        format: (v) => (p.step < 1 ? v.toFixed(p.step < 0.1 ? 2 : 1) : Math.round(v)) + (p.unit ? ' ' + p.unit : ''),
        onInput: (v) => { values[p.key] = v; update(); },
      }));
    }
  }
  if (!f.params.length) body.push(el('div', { class: 'note' }, 'This filter has no settings.'));
  if (isMask) body.push(el('div', { class: 'note' }, 'Applies to the layer mask.'));
  const previewCheck = checkField({ label: 'Preview', value: true, onChange: (v) => { previewOn = v; update(); } });
  update();
  modal({
    title: f.name,
    width: 360,
    body,
    footLeft: previewCheck,
    buttons: [
      { label: 'Cancel', cancel: true, onClick: () => { app.previews.delete(l); app.render(); } },
      {
        label: 'Apply', primary: true, onClick: () => {
          clearTimeout(timer);
          app.prefs.filterValues = { ...(app.prefs.filterValues || {}), [id]: { ...values } };
          app.emit('busy', true, 'Applying ' + f.name + '…');
          try {
            const out = compute();
            if (isMask) l.setMask(out); else l.setCanvas(out);
            app.previews.delete(l);
            app.lastFilter = id;
            commit(f.name);
          } catch (e) {
            alertDialog('Filter failed', e.message);
          } finally {
            app.emit('busy', false);
          }
        },
      },
    ],
    onClose: (r) => { if (!r) { app.previews.delete(l); app.render(); } },
  });
}

export function repeatLastFilter() {
  if (app.lastFilter) filterDialog(app.lastFilter);
}

// ---------------------------------------------------------------------------

export async function aboutDialog() {
  const info = await appInfo();
  modal({
    title: 'About Lumen Studio',
    width: 420,
    body: [
      el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } },
        el('img', { src: 'assets/icon.png', width: 56, height: 56 }),
        el('div', {}, el('div', { style: { fontSize: '18px', fontWeight: 600, color: '#fff' } }, 'Lumen Studio'),
          el('div', { class: 'note' }, `Version ${info.version}${info.electron ? ' · Electron ' + info.electron : ''}`))),
      el('div', {}, 'A photo editor that combines a Lightroom-style library and non-destructive Develop module with Photoshop-style layers, masks, selections and painting tools.'),
      el('div', { class: 'note' }, isDesktop ? `Library data: ${info.userData}` : 'Running in browser mode.'),
    ],
    buttons: [{ label: 'Close', primary: true }],
  });
}

export const SHORTCUTS = {
  General: [
    ['New document', 'Ctrl+N'], ['Open', 'Ctrl+O'], ['Import photos', 'Ctrl+Shift+O'], ['Save project', 'Ctrl+S'],
    ['Export', 'Ctrl+Shift+E'], ['Close tab', 'Ctrl+W'], ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'],
    ['Library / Develop / Edit', 'Ctrl+Alt+1 / 2 / 3'], ['Fit / 100%', 'Ctrl+0 / Ctrl+1'], ['Zoom in / out', 'Ctrl++ / Ctrl+-'],
    ['Before / after', '\\'], ['Toggle panels', 'Tab'], ['Full screen', 'F11'],
  ],
  Tools: [
    ['Move', 'V'], ['Marquee (rect/ellipse)', 'M'], ['Lasso', 'L'], ['Magic wand', 'W'], ['Crop', 'C'], ['Brush', 'B'],
    ['Eraser', 'E'], ['Clone stamp', 'S'], ['Spot healing', 'J'], ['Gradient / Bucket', 'G'], ['Text', 'T'], ['Eyedropper', 'I'],
    ['Hand / Zoom', 'H / Z'], ['Free transform', 'Ctrl+T'], ['Brush size', '[ / ]'], ['Swap / reset colors', 'X / D'],
  ],
  Layers: [
    ['New layer', 'Ctrl+Shift+N'], ['Duplicate / Layer via copy', 'Ctrl+J'], ['Layer via cut', 'Ctrl+Shift+J'],
    ['Merge down', 'Ctrl+E'], ['Move layer up / down', 'Ctrl+] / Ctrl+['], ['Select all / Deselect', 'Ctrl+A / Ctrl+D'],
    ['Invert selection', 'Ctrl+Shift+I'], ['Fill with foreground', 'Alt+Backspace'], ['Clear selection', 'Delete'],
  ],
  'Library & Develop': [
    ['Rate 0–5 stars', '0 – 5'], ['Pick / Reject / Unflag', 'P / X / U'], ['Open in Develop', 'Enter'],
    ['Copy / paste settings', 'Ctrl+Shift+C / V'], ['Auto tone', 'Ctrl+U'], ['Crop (Develop)', 'R'], ['Spot heal (Develop)', 'Q'],
  ],
};

export function shortcutsDialog() {
  const cols = el('div', { class: 'kbd-cols' });
  for (const [group, rows] of Object.entries(SHORTCUTS)) {
    cols.appendChild(el('div', {}, el('h4', {}, group), el('table', { class: 'kbd-table' }, rows.map(([a, b]) => el('tr', {}, el('td', {}, a), el('td', {}, b))))));
  }
  modal({ title: 'Keyboard Shortcuts', width: 760, body: cols, buttons: [{ label: 'Close', primary: true }] });
}
