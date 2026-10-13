// Develop module panels: right-side adjustments and left-side presets/history.

import { app } from '../app.js';
import { el, deepClone, debounce } from '../util.js';
import { slider, section, segmented, button, iconButton, selectField } from './widgets.js';
import { icon } from './icons.js';
import { histogramView } from './histogram.js';
import { curveEditor } from './curveEditor.js';
import { colorWheel } from './colorWheel.js';
import { historyView } from './layersPanel.js';
import {
  HSL_BANDS, BUILTIN_PRESETS, applyPreset, defaultDevelop, previewThumbnail, autoWhiteBalance,
} from '../develop.js';
import { activeDevelopLayer, commit, autoTone, setDevelop } from '../ops.js';
import { textPrompt } from './dialogs.js';
import { storeSave } from '../platform.js';

const LABELS = {
  temp: 'Temperature', tint: 'Tint', exposure: 'Exposure', contrast: 'Contrast', highlights: 'Highlights',
  shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks', clarity: 'Clarity', dehaze: 'Dehaze',
  vibrance: 'Vibrance', saturation: 'Saturation', sharpen: 'Sharpening', sharpenRadius: 'Radius',
  noise: 'Luminance', colorNoise: 'Color', vignette: 'Vignette', vignetteMidpoint: 'Midpoint',
  vignetteFeather: 'Feather', grain: 'Grain', grainSize: 'Size',
};

function settings() {
  const l = activeDevelopLayer();
  return l ? l.develop : null;
}

function live() {
  app.render();
}

export function buildDevelopRight(container) {
  const controls = []; // { refresh() }
  const scroll = el('div', { class: 'panel-scroll' });

  // ---- target / tools ----
  const tools = el('div', { class: 'dev-tools' });
  for (const id of ['crop', 'heal', 'wb', 'hand', 'zoom']) {
    const t = app.tools[id];
    const b = el('button', { class: 'tool-btn', title: `${t.name}${id === 'crop' ? ' (R)' : id === 'heal' ? ' (Q)' : id === 'wb' ? ' (W)' : ` (${t.key})`}`, 'data-tool': id }, icon(t.icon, 18));
    b.addEventListener('click', () => {
      if (id === 'wb') app.tools.wb.returnTo = app.toolId !== 'wb' ? app.toolId : 'hand';
      app.setTool(app.toolId === id && id !== 'hand' ? 'hand' : id);
    });
    tools.appendChild(b);
  }
  app.on('tool', () => tools.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === app.toolId)));

  const targetName = el('b', {}, '–');
  const target = el('div', { class: 'dev-target' }, el('span', {}, 'Adjusting: ', targetName));

  // ---- helpers ----
  const sl = (key, opts = {}) => {
    const d = defaultDevelop();
    const isExp = key === 'exposure';
    const s = slider({
      label: LABELS[key] || key,
      min: opts.min ?? (isExp ? -5 : -100),
      max: opts.max ?? (isExp ? 5 : 100),
      step: opts.step ?? (isExp ? 0.01 : 1),
      value: d[key],
      def: d[key],
      gradient: opts.gradient,
      format: opts.format,
      onInput: (v) => {
        const st = settings();
        if (!st) return;
        st[key] = v;
        live();
      },
      onCommit: () => {
        if (!settings()) return;
        commit(LABELS[key] || key);
      },
    });
    controls.push({ refresh: (st) => s.set(st[key]) });
    return s;
  };

  // ---- Basic ----
  const treatment = segmented({
    options: [['color', 'Color'], ['bw', 'Black & White']],
    value: 'color',
    onChange: (v) => {
      const st = settings();
      if (!st) return;
      st.bw = v === 'bw';
      commit(st.bw ? 'Black & White' : 'Color');
      refreshAll();
    },
  });
  controls.push({ refresh: (st) => treatment.set(st.bw ? 'bw' : 'color') });

  const wbSel = selectField({
    options: [['custom', 'Custom'], ['shot', 'As Shot'], ['auto', 'Auto']],
    value: 'shot',
    onChange: (v) => {
      const l = activeDevelopLayer();
      if (!l) return;
      if (v === 'auto') setDevelop({ ...l.develop, ...autoWhiteBalance(l.canvas) }, 'Auto White Balance');
      else if (v === 'shot') setDevelop({ ...l.develop, temp: 0, tint: 0 }, 'White Balance: As Shot');
    },
  });
  controls.push({ refresh: (st) => wbSel.set(st.temp || st.tint ? 'custom' : 'shot') });
  const wbPick = iconButton('wb', 'White balance picker (W): click something neutral', () => {
    app.tools.wb.returnTo = app.toolId !== 'wb' ? app.toolId : 'hand';
    app.setTool('wb');
  });

  const basic = el('div', {},
    el('div', { class: 'treatment' }, el('span', { class: 'field-label' }, 'Treatment'), treatment),
    el('div', { class: 'wb-row' }, el('span', { class: 'field-label' }, 'WB'), wbSel, wbPick),
    sl('temp', { gradient: 'linear-gradient(to right, #3b6fe0, #d8d8d8, #e8c23a)' }),
    sl('tint', { gradient: 'linear-gradient(to right, #3fbf4f, #d8d8d8, #d64fd6)' }),
    el('div', { class: 'wb-row' }, el('span', { class: 'sub-label', style: { margin: '8px 0 0' } }, 'Tone'),
      button({ label: 'Auto', title: 'Auto tone (Ctrl+U)', onClick: () => autoTone() })),
    sl('exposure', { format: (v) => (v > 0 ? '+' : '') + v.toFixed(2) }),
    sl('contrast'), sl('highlights'), sl('shadows'), sl('whites'), sl('blacks'),
    el('div', { class: 'sub-label' }, 'Presence'),
    sl('clarity'), sl('dehaze'), sl('vibrance'), sl('saturation'));

  // ---- Tone curve ----
  const curve = curveEditor({
    get: () => (settings() ? settings().curve : defaultDevelop().curve),
    onChange: (c, final) => {
      const st = settings();
      if (!st) return;
      st.curve = deepClone(c);
      live();
      if (final) commit('Tone Curve');
    },
  });
  controls.push({ refresh: () => curve.refresh() });
  app.on('rendered', debounce(() => curve.refresh(), 300));

  // ---- Color mixer ----
  let hslMode = 'hue';
  const hslBox = el('div');
  const hslTabs = segmented({
    options: [['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']],
    value: hslMode,
    cls: 'full hsl-tabs',
    onChange: (v) => { hslMode = v; buildHsl(); },
  });
  const mixerTitle = el('span');
  function buildHsl() {
    hslBox.innerHTML = '';
    const st = settings() || defaultDevelop();
    const bw = st.bw;
    hslTabs.style.display = bw ? 'none' : '';
    mixerTitle.textContent = bw ? 'B&W Mix' : '';
    const mode = bw ? 'lum' : hslMode;
    HSL_BANDS.forEach((band, i) => {
      let gradient;
      if (mode === 'hue') {
        const prev = HSL_BANDS[(i + 7) % 8].color;
        const next = HSL_BANDS[(i + 1) % 8].color;
        gradient = `linear-gradient(to right, ${prev}, ${band.color}, ${next})`;
      } else if (mode === 'sat') {
        gradient = `linear-gradient(to right, #808080, ${band.color})`;
      } else {
        gradient = `linear-gradient(to right, #111, ${band.color}, #fff)`;
      }
      const s = slider({
        label: band.name, min: -100, max: 100, step: 1, value: st.hsl[mode][i], def: 0, gradient,
        onInput: (v) => { const cur = settings(); if (!cur) return; cur.hsl[mode][i] = v; live(); },
        onCommit: () => commit(bw ? 'B&W Mix' : 'Color Mixer'),
      });
      hslBox.appendChild(s);
    });
  }
  controls.push({ refresh: () => buildHsl() });
  const mixer = el('div', {}, hslTabs, mixerTitle, hslBox);

  // ---- Color grading ----
  const wheelFor = (key, label) => {
    const w = colorWheel({
      label, h: 0, s: 0,
      onChange: (h, s, final) => {
        const st = settings();
        if (!st) return;
        st.grading[key] = { h, s };
        live();
        if (final) commit('Color Grading');
      },
    });
    controls.push({ refresh: (st) => w.set(st.grading[key].h, st.grading[key].s) });
    return w;
  };
  const balance = slider({
    label: 'Balance', min: -100, max: 100, value: 0, def: 0,
    onInput: (v) => { const st = settings(); if (!st) return; st.grading.balance = v; live(); },
    onCommit: () => commit('Color Grading'),
  });
  controls.push({ refresh: (st) => balance.set(st.grading.balance) });
  const grading = el('div', {},
    el('div', { class: 'wheels' }, wheelFor('shadows', 'Shadows'), wheelFor('midtones', 'Midtones'), wheelFor('highlights', 'Highlights')),
    balance,
    el('div', { class: 'note' }, 'Drag in a wheel to tint · double-click to clear'));

  // ---- Detail ----
  const detail = el('div', {},
    el('div', { class: 'sub-label' }, 'Sharpening'),
    sl('sharpen', { min: 0, max: 150 }),
    sl('sharpenRadius', { min: 0.5, max: 3, step: 0.1, format: (v) => v.toFixed(1) }),
    el('div', { class: 'sub-label' }, 'Noise Reduction'),
    sl('noise', { min: 0, max: 100 }),
    sl('colorNoise', { min: 0, max: 100 }),
    el('div', { class: 'note' }, 'Zoom to 100% (Ctrl+1) to judge sharpening and noise.'));

  // ---- Effects ----
  const effects = el('div', {},
    el('div', { class: 'sub-label' }, 'Vignette'),
    sl('vignette'),
    sl('vignetteMidpoint', { min: 0, max: 100 }),
    sl('vignetteFeather', { min: 0, max: 100 }),
    el('div', { class: 'sub-label' }, 'Grain'),
    sl('grain', { min: 0, max: 100 }),
    sl('grainSize', { min: 0, max: 100 }));

  scroll.append(
    histogramView(),
    tools,
    target,
    section('Basic', basic, { id: 'dev-basic' }),
    section('Tone Curve', curve, { id: 'dev-curve', open: false }),
    section('Color Mixer', mixer, { id: 'dev-hsl', open: false }),
    section('Color Grading', grading, { id: 'dev-grading', open: false }),
    section('Detail', detail, { id: 'dev-detail', open: false }),
    section('Effects', effects, { id: 'dev-effects', open: false }),
  );

  const beforeBtn = button({ label: 'Before', iconName: 'compare', title: 'Show before (\\)', onClick: () => toggleBefore() });
  const footer = el('div', { class: 'dev-footer' },
    button({ label: 'Copy', iconName: 'copy', title: 'Copy settings (Ctrl+Shift+C)', onClick: () => copySettings() }),
    button({ label: 'Paste', title: 'Paste settings (Ctrl+Shift+V)', onClick: () => pasteSettings() }),
    button({ label: 'Reset', iconName: 'reset', title: 'Reset all adjustments', onClick: () => setDevelop(defaultDevelop(), 'Reset') }),
    beforeBtn);
  app.on('before', () => beforeBtn.classList.toggle('primary', app.before));

  const root = el('div', { class: 'panel-stack' }, scroll, footer);
  container.appendChild(root);

  function refreshAll() {
    const l = activeDevelopLayer();
    const st = l ? l.develop : defaultDevelop();
    targetName.textContent = l ? l.name : 'No photo';
    root.style.opacity = l ? '' : '0.5';
    root.style.pointerEvents = l ? '' : 'none';
    for (const c of controls) c.refresh(st);
  }
  app.on('doc', refreshAll);
  app.on('develop-changed', refreshAll);
  app.on('doc-change', (d) => {
    if (d === app.doc) refreshAll();
  });
  refreshAll();
  return root;
}

export function toggleBefore(v) {
  app.before = v ?? !app.before;
  app.emit('before');
  app.render();
}

export function copySettings() {
  const st = settings();
  if (!st) return;
  app.clipboardDevelop = deepClone(st);
  app.status('Develop settings copied');
}

export function pasteSettings() {
  if (!app.clipboardDevelop) { app.status('Copy develop settings first.'); return; }
  setDevelop(deepClone(app.clipboardDevelop), 'Paste Settings');
}

// ---------------------------------------------------------------------------
// Left panel: presets + history

export function savePrefs() {
  return storeSave('prefs.json', JSON.stringify(app.prefs));
}

export function buildDevelopLeft(container) {
  const list = el('div', { class: 'preset-list' });
  const userList = el('div', { class: 'preset-list' });
  const thumbs = new Map();

  function presetRow(p, isUser) {
    const img = el('canvas', { width: 88, height: 64 });
    thumbs.set(p, img);
    const row = el('div', { class: 'preset-item', title: 'Click to apply · hover to preview' }, img, el('span', { class: 'name' }, p.name),
      isUser ? iconButton('trash', 'Delete preset', () => {
        app.prefs.userPresets = app.prefs.userPresets.filter((x) => x !== p);
        savePrefs();
        build();
      }) : null);
    row.addEventListener('mouseenter', () => {
      const l = activeDevelopLayer();
      if (!l) return;
      app.previews.set(l, { develop: applyPreset(p.settings) });
      app.render();
    });
    row.addEventListener('mouseleave', () => {
      const l = activeDevelopLayer();
      if (l) app.previews.delete(l);
      app.render();
    });
    row.addEventListener('click', () => {
      const l = activeDevelopLayer();
      if (!l) return;
      app.previews.delete(l);
      setDevelop(applyPreset(p.settings), 'Preset: ' + p.name);
    });
    return row;
  }

  function build() {
    list.innerHTML = '';
    userList.innerHTML = '';
    thumbs.clear();
    const none = { name: 'None (reset)', settings: {} };
    list.appendChild(presetRow(none, false));
    for (const p of BUILTIN_PRESETS) list.appendChild(presetRow(p, false));
    for (const p of app.prefs.userPresets || []) userList.appendChild(presetRow(p, true));
    if (!(app.prefs.userPresets || []).length) userList.appendChild(el('div', { class: 'note', style: { padding: '4px 14px' } }, 'Save your own look with +'));
    renderThumbs();
  }

  let thumbTimer = null;
  function renderThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      const l = activeDevelopLayer();
      if (!l || !l.canvas) return;
      const entries = [...thumbs.entries()];
      let i = 0;
      const step = () => {
        const batch = entries.slice(i, i + 4);
        i += 4;
        for (const [p, c] of batch) {
          try {
            const t = previewThumbnail(l.canvas, applyPreset(p.settings), 120);
            const g = c.getContext('2d');
            g.clearRect(0, 0, c.width, c.height);
            const s = Math.max(c.width / t.width, c.height / t.height);
            g.drawImage(t, (c.width - t.width * s) / 2, (c.height - t.height * s) / 2, t.width * s, t.height * s);
          } catch (e) { console.warn(e); }
        }
        if (i < entries.length) requestAnimationFrame(step);
      };
      step();
    }, 400);
  }

  const addBtn = iconButton('plus', 'Save current settings as a preset', async () => {
    const st = settings();
    if (!st) return;
    const name = await textPrompt({ title: 'New Preset', label: 'Preset name', value: 'My Preset' });
    if (!name) return;
    app.prefs.userPresets = [...(app.prefs.userPresets || []), { name, settings: deepClone(st) }];
    await savePrefs();
    build();
    app.status(`Preset “${name}” saved`);
  });

  const scroll = el('div', { class: 'panel-scroll' },
    section('Presets', list, { id: 'dev-presets' }),
    section('User Presets', userList, { id: 'dev-user-presets', actions: addBtn }),
    section('History', historyView(), { id: 'dev-history' }));
  const root = el('div', { class: 'left-panel panel-stack' }, scroll);
  container.appendChild(root);
  build();
  app.on('doc', renderThumbs);
  app.on('doc-change', (d) => {
    if (d === app.doc) {
      const l = activeDevelopLayer();
      const key = l ? `${l.id}|${l.version}` : '';
      if (key !== renderThumbs.key) { renderThumbs.key = key; renderThumbs(); }
    }
  });
  return root;
}

