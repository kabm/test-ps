// Application bootstrap: builds the UI and wires modules together.

import { app } from './app.js';
import { el } from './util.js';
import { Viewport } from './viewport.js';
import { Catalog } from './catalog.js';
import { moveTool, handTool, zoomTool, eyedropperTool, wbTool } from './tools/basic.js';
import { marqueeTool, ellipseTool, lassoTool, wandTool } from './tools/select.js';
import { brushTool, eraserTool, cloneTool, healTool, bucketTool, gradientTool } from './tools/paint.js';
import { cropTool } from './tools/crop.js';
import { textTool } from './tools/text.js';
import { transformTool } from './tools/transform.js';
import { buildMenubar } from './ui/menu.js';
import { buildToolbar } from './ui/toolbar.js';
import { buildDevelopRight, buildDevelopLeft } from './ui/developPanel.js';
import { buildEditRight } from './ui/layersPanel.js';
import { buildLibraryView, buildLibraryLeft, buildLibraryRight, importPhotos, lib } from './ui/library.js';
import { buildFilmstrip } from './ui/filmstrip.js';
import { updateHistogram, clearHistogram } from './ui/histogram.js';
import { installShortcuts } from './shortcuts.js';
import { icon } from './ui/icons.js';
import { button } from './ui/widgets.js';
import { activateDoc, closeDoc, closeAll, openFileRefs, updateTitle } from './commands.js';
import { newDocDialog } from './ui/dialogs.js';
import {
  storeLoad, storeSave, onOpenFiles, launchFiles, fileRefsFromDrop, onCloseRequested, confirmClose, isDesktop,
} from './platform.js';
import { getGL } from './gl.js';
import { debounce } from './util.js';
import { Stroke, makeStamp } from './brush.js';
import { healArea } from './heal.js';
import { renderDevelop, defaultDevelop, whiteBalanceFromPixel } from './develop.js';
import { newDocument, serializeProject } from './commands.js';
import { fileRefFromPath, writeFile as platformWriteFile } from './platform.js';
import { cropTo, fillWith } from './ops.js';

// Internals exposed for automated tests and debugging from DevTools.
window.__lumenInternals = {
  Stroke, makeStamp, healArea, renderDevelop, defaultDevelop, whiteBalanceFromPixel, newDocument, cropTo, fillWith, closeDoc,
  fileRefFromPath, openFileRefs, serializeProject, writeFile: platformWriteFile,
};

const TOOLS = [
  moveTool, marqueeTool, ellipseTool, lassoTool, wandTool, cropTool, transformTool, brushTool, eraserTool,
  cloneTool, healTool, gradientTool, bucketTool, textTool, eyedropperTool, handTool, zoomTool, wbTool,
];

const $ = (id) => document.getElementById(id);

function panelHost(parent, cls = '') {
  const d = el('div', { class: 'panel-host ' + cls, style: { flexDirection: 'column', flex: '1', minHeight: '0' } });
  parent.appendChild(d);
  return d;
}

async function init() {
  // GPU check up front so we can explain problems clearly
  try {
    getGL();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font:14px Segoe UI, sans-serif;color:#ddd">
      <h2>Lumen Studio needs WebGL 2</h2><p>${e.message}</p>
      <p>Please update your graphics driver and restart the app.</p></div>`;
    return;
  }

  for (const t of TOOLS) app.tools[t.id] = t;

  // load preferences
  try {
    const p = await storeLoad('prefs.json');
    if (p) Object.assign(app.prefs, JSON.parse(p));
  } catch { /* defaults */ }
  const savePrefs = debounce(() => storeSave('prefs.json', JSON.stringify(app.prefs)), 500);

  app.catalog = new Catalog();
  await app.catalog.load();

  // ---- layout ----
  app.view = new Viewport($('viewport'));
  await buildMenubar($('menus'));

  const left = $('left');
  const right = $('right');
  const hosts = {
    left: { edit: panelHost(left), develop: panelHost(left), library: panelHost(left) },
    right: { edit: panelHost(right), develop: panelHost(right), library: panelHost(right) },
  };
  buildToolbar(hosts.left.edit);
  buildDevelopLeft(hosts.left.develop);
  buildLibraryLeft(hosts.left.library);
  buildEditRight(hosts.right.edit);
  buildDevelopRight(hosts.right.develop);
  buildLibraryRight(hosts.right.library);
  buildLibraryView($('library-view'));
  buildFilmstrip($('filmstrip'));
  buildTabs();
  buildStatusbar();
  buildEmptyState();

  // ---- modules ----
  app.setModule = (m) => {
    if (m !== 'library' && !app.doc && app.docs.length) activateDoc(app.docs[0]);
    const prev = app.module;
    app.module = m;
    document.body.classList.remove('m-library', 'm-develop', 'm-edit');
    document.body.classList.add('m-' + m);
    for (const side of ['left', 'right']) {
      for (const [k, host] of Object.entries(hosts[side])) host.classList.toggle('show', k === m);
    }
    document.querySelectorAll('#modules button').forEach((b) => b.classList.toggle('active', b.dataset.module === m));
    // pick a sensible tool for the module
    const t = app.tools[app.toolId];
    if (!t || !t.modules.includes(m)) app.setTool(m === 'develop' ? 'hand' : 'move');
    else app.emit('tool');
    if (prev !== m) app.emit('module', m);
    refreshEmpty();
    $('filmstrip').classList.toggle('hidden', app.prefs.filmstrip === false);
    requestAnimationFrame(() => { app.view.resize(); });
  };
  document.querySelectorAll('#modules button').forEach((b) => b.addEventListener('click', () => app.setModule(b.dataset.module)));

  app.setTool = (id) => {
    const next = app.tools[id];
    if (!next) return;
    const cur = app.tools[app.toolId];
    if (cur && cur !== next && cur.deactivate) cur.deactivate();
    app.toolId = id;
    if (next.activate) next.activate();
    app.view.updateCursor();
    app.emit('tool');
    app.view.requestFrame();
  };

  app.toggleFilmstrip = () => {
    app.prefs.filmstrip = app.prefs.filmstrip === false;
    $('filmstrip').classList.toggle('hidden', app.prefs.filmstrip === false);
    savePrefs();
    requestAnimationFrame(() => app.view.resize());
  };
  app.togglePanels = () => {
    app.panelsHidden = !app.panelsHidden;
    left.style.display = app.panelsHidden ? 'none' : '';
    right.style.display = app.panelsHidden ? 'none' : '';
    requestAnimationFrame(() => app.view.resize());
  };
  app.commands = { newDoc: newDocDialog };

  // ---- options bar ----
  const optionsbar = $('optionsbar');
  let cleanup = null;
  const buildOptions = () => {
    if (cleanup) { cleanup(); cleanup = null; }
    optionsbar.innerHTML = '';
    if (app.module === 'library') {
      optionsbar.appendChild(el('div', { class: 'tool-title' }, icon('grid', 16), 'Library'));
      optionsbar.appendChild(el('span', { class: 'hint' }, 'Double-click a photo to develop it · 0–5 to rate · P / X to pick or reject'));
      return;
    }
    const t = app.tool;
    if (!t) return;
    optionsbar.appendChild(el('div', { class: 'tool-title' }, icon(t.icon, 16), t.name));
    if (t.options) {
      const bar = { append: (...nodes) => nodes.forEach((n) => n && optionsbar.appendChild(n)) };
      t.options(bar);
      cleanup = bar.cleanup || null;
    }
  };
  app.on('tool', buildOptions);
  app.on('tool-options', buildOptions);
  app.on('module', buildOptions);
  app.on('doc', () => { if (app.toolId === 'crop' || app.toolId === 'text') buildOptions(); });

  // ---- events ----
  app.on('rendered', (canvas) => updateHistogram(canvas));
  app.on('doc', (d) => {
    if (!d) clearHistogram();
    refreshEmpty();
    renderTabs();
  });
  app.on('docs', () => { renderTabs(); refreshEmpty(); });
  app.on('doc-change', () => { renderTabs(); updateTitle(); });
  app.on('busy', (on, msg) => {
    $('busy').classList.toggle('show', !!on);
    $('busy').querySelector('span').textContent = msg || '';
  });
  let toastTimer = null;
  app.on('status', (msg, ms) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3000);
    const sm = document.querySelector('#statusbar .msg');
    if (sm) sm.textContent = msg;
  });
  app.on('module', savePrefs);

  installShortcuts();
  installDragDrop();

  // external files (command line / "Open with")
  onOpenFiles((refs) => openFileRefs(refs));
  const initial = await launchFiles();

  // closing the window
  onCloseRequested(async () => {
    const ok = await closeAll();
    await app.catalog.save();
    await storeSave('prefs.json', JSON.stringify(app.prefs));
    if (ok) confirmClose();
  });
  window.addEventListener('beforeunload', () => { app.catalog.save(); });

  app.setModule('library');
  app.setTool('move');
  if (initial.length) await openFileRefs(initial);
  document.body.classList.add('ready');
  window.__lumenReady = true;
}

// ---------------------------------------------------------------------------

function buildTabs() {
  renderTabs();
}

function renderTabs() {
  const tabs = $('tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  for (const d of app.docs) {
    const close = el('button', { class: 'icon-btn', title: 'Close (Ctrl+W)' }, icon('close', 12));
    close.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(d); });
    const tab = el('div', { class: 'tab' + (d === app.doc ? ' active' : ''), title: d.sourcePath || d.filePath || d.name },
      el('span', { class: 'name' }, d.name + (d.dirty && (d.filePath || !d.catalogId) ? ' •' : '')), close);
    tab.addEventListener('click', () => activateDoc(d));
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeDoc(d); });
    tabs.appendChild(tab);
  }
}

function buildStatusbar() {
  const sb = $('statusbar');
  const size = el('span');
  const pos = el('span');
  const zoomInput = el('input', { type: 'text', value: '100%' });
  zoomInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const v = parseFloat(zoomInput.value);
      if (v > 0) app.view.setZoom(v / 100);
      zoomInput.blur();
    }
  });
  const zoom = el('span', { class: 'zoom' }, icon('zoom', 12), zoomInput);
  const layerInfo = el('span');
  const msg = el('span', { class: 'msg' });
  sb.append(zoom, size, pos, layerInfo, msg);
  const upd = () => {
    const d = app.doc;
    const visible = d && app.module !== 'library';
    zoom.style.visibility = visible ? '' : 'hidden';
    size.textContent = visible ? `${d.width} × ${d.height} px` : app.module === 'library' ? `${app.catalog.entries.length} photos in library` : '';
    layerInfo.textContent = visible && d.active ? `${d.active.name}${app.maskEditing ? ' (mask)' : ''}` : '';
    if (visible) zoomInput.value = Math.round(app.view.view.zoom * 1000) / 10 + '%';
  };
  app.on('zoom', upd);
  app.on('doc', upd);
  app.on('doc-change', upd);
  app.on('module', upd);
  app.on('mask-editing', upd);
  app.catalog.on('change', upd);
  app.on('pointer', (p) => {
    pos.textContent = p && app.doc ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : '';
  });
  upd();
}

function buildEmptyState() {
  const es = $('empty-state');
  es.append(
    el('img', { class: 'logo', src: 'assets/icon.png' }),
    el('h2', {}, 'No photo open'),
    el('div', {}, 'Open a photo from the Library, or start with a blank canvas.'),
    el('div', { class: 'actions' },
      button({ label: 'Go to Library', iconName: 'grid', cls: 'primary big', onClick: () => app.setModule('library') }),
      button({ label: 'Import Photos', iconName: 'import', cls: 'big', onClick: () => importPhotos() }),
      button({ label: 'New Canvas', iconName: 'plus', cls: 'big', onClick: () => newDocDialog() })));
}

function refreshEmpty() {
  $('empty-state').classList.toggle('show', app.module !== 'library' && !app.doc);
}

function installDragDrop() {
  const overlay = $('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    depth++;
    overlay.classList.add('show');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    depth = 0;
    overlay.classList.remove('show');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const refs = fileRefsFromDrop(e.dataTransfer.files);
    if (app.module === 'library') {
      const images = refs.filter((r) => !r.name.toLowerCase().endsWith('.lumen'));
      const projects = refs.filter((r) => r.name.toLowerCase().endsWith('.lumen'));
      if (images.length) await app.catalog.add(images);
      if (projects.length) await openFileRefs(projects);
    } else {
      await openFileRefs(refs);
    }
  });
}

window.addEventListener('error', (e) => console.error('Uncaught', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled', e.reason));

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export { lib, isDesktop };
