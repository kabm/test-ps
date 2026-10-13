// Library module: photo grid with ratings, flags, filtering, metadata and quick develop.

import { app } from '../app.js';
import { el, debounce } from '../util.js';
import { slider, selectField, section, button } from './widgets.js';
import { icon } from './icons.js';
import { formatExif } from '../imageio.js';
import { openCatalogEntry, openFileRefs } from '../commands.js';
import { pickImages, pickFolderImages, messageBox } from '../platform.js';
import { batchExportDialog } from './dialogs.js';
import { BUILTIN_PRESETS, applyPreset, autoTone as computeAutoTone, isIdentityDevelop, normalizeDevelop } from '../develop.js';

export const lib = {
  selected: new Set(),
  focus: null, // last clicked id
  filter: { rating: 0, flag: 'all', search: '', edited: 'all' },
  sort: 'added',
  cellSize: 190,
};

export function visibleEntries() {
  const c = app.catalog;
  if (!c) return [];
  const f = lib.filter;
  const q = f.search.trim().toLowerCase();
  let list = c.entries.filter((e) => {
    if (f.rating && (e.rating || 0) < f.rating) return false;
    if (f.flag === 'picked' && e.flag !== 1) return false;
    if (f.flag === 'rejected' && e.flag !== -1) return false;
    if (f.flag === 'unflagged' && e.flag) return false;
    if (f.edited === 'edited' && !e.develop) return false;
    if (q && !e.name.toLowerCase().includes(q)) return false;
    return true;
  });
  const by = {
    added: (a, b) => a.addedAt - b.addedAt,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    date: (a, b) => (a.captureDate || a.addedAt) - (b.captureDate || b.addedAt),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.addedAt - b.addedAt,
  }[lib.sort];
  list = list.slice().sort(by);
  return list;
}

export function selectedEntries() {
  return visibleEntries().filter((e) => lib.selected.has(e.id));
}

function starsEl(e) {
  const wrap = el('span', { class: 'stars', title: 'Rating (0–5)' });
  for (let i = 1; i <= 5; i++) {
    const s = el('span', { class: i <= (e.rating || 0) ? 'on' : '' }, '★');
    s.addEventListener('click', (ev) => {
      ev.stopPropagation();
      app.catalog.update(e.id, { rating: e.rating === i ? 0 : i });
    });
    wrap.appendChild(s);
  }
  return wrap;
}

export function buildLibraryView(container) {
  const count = el('span', { class: 'count' });
  const search = el('input', { type: 'text', class: 'search', placeholder: 'Search file names…' });
  search.addEventListener('input', debounce(() => { lib.filter.search = search.value; render(); }, 150));
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const sortSel = selectField({
    label: 'Sort', options: [['added', 'Import order'], ['date', 'Capture date'], ['name', 'File name'], ['rating', 'Rating']], value: lib.sort,
    onChange: (v) => { lib.sort = v; render(); },
  });
  const sizeSl = slider({
    label: 'Thumbnails', min: 110, max: 360, value: lib.cellSize, def: 190, format: () => '',
    onInput: (v) => { lib.cellSize = v; grid.style.setProperty('--cell', v + 'px'); },
  });
  const toolbar = el('div', { class: 'lib-toolbar' },
    button({ label: 'Import Photos', iconName: 'import', cls: 'primary', onClick: () => importPhotos() }),
    button({ label: 'Import Folder', iconName: 'folder', onClick: () => importFolder() }),
    search, sortSel, sizeSl, el('div', { class: 'spacer' }), count);
  const grid = el('div', { class: 'lib-grid', tabIndex: 0 });
  grid.style.setProperty('--cell', lib.cellSize + 'px');
  container.append(toolbar, grid);

  const cells = new Map();
  const io = new IntersectionObserver((items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      const cell = it.target;
      io.unobserve(cell);
      loadThumb(cell);
    }
  }, { root: grid, rootMargin: '400px' });

  function loadThumb(cell) {
    const e = app.catalog.get(cell.dataset.id);
    if (!e) return;
    const holder = cell.querySelector('.thumb');
    app.catalog.thumb(e).then((url) => {
      holder.innerHTML = '';
      if (url) holder.appendChild(el('img', { src: url, draggable: false }));
      else holder.appendChild(el('div', { class: 'err' }, e.missing ? 'File not found' : 'Preview unavailable'));
    });
  }

  function cellFor(e) {
    const holder = el('div', { class: 'thumb' }, e._thumbUrl ? el('img', { src: e._thumbUrl, draggable: false }) : null);
    const badge = e.isRaw ? el('span', { class: 'badge' }, (e.name.split('.').pop() || 'RAW').toUpperCase()) : null;
    const flag = e.flag === 1 ? el('span', { class: 'flag', title: 'Picked' }, icon('flag', 15)) : e.flag === -1 ? el('span', { class: 'flag reject', title: 'Rejected' }, icon('reject', 15)) : null;
    const edited = e.develop && !isIdentityDevelop(e.develop) ? el('span', { class: 'edited', title: 'Has develop adjustments' }, icon('sliders', 11)) : null;
    const cell = el('div', { class: 'lib-cell' + (lib.selected.has(e.id) ? ' selected' : ''), 'data-id': e.id, title: e.path || e.name },
      holder, badge, flag, edited,
      el('div', { class: 'meta' }, el('span', { class: 'fname' }, e.name), starsEl(e)));
    cell.addEventListener('click', (ev) => onCellClick(ev, e));
    cell.addEventListener('dblclick', () => openCatalogEntry(e, { module: 'develop' }));
    cell.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!lib.selected.has(e.id)) { lib.selected = new Set([e.id]); lib.focus = e.id; refreshSelection(); }
    });
    return cell;
  }

  function onCellClick(ev, e) {
    const list = visibleEntries();
    if (ev.shiftKey && lib.focus) {
      const a = list.findIndex((x) => x.id === lib.focus);
      const b = list.findIndex((x) => x.id === e.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!ev.ctrlKey) lib.selected.clear();
      for (let i = lo; i <= hi; i++) lib.selected.add(list[i].id);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (lib.selected.has(e.id)) lib.selected.delete(e.id); else lib.selected.add(e.id);
      lib.focus = e.id;
    } else {
      lib.selected = new Set([e.id]);
      lib.focus = e.id;
    }
    refreshSelection();
  }

  function refreshSelection() {
    for (const [id, cell] of cells) cell.classList.toggle('selected', lib.selected.has(id));
    app.emit('library-selection');
  }

  function render() {
    const list = visibleEntries();
    const total = app.catalog.entries.length;
    count.textContent = total ? `${list.length} of ${total} photo${total === 1 ? '' : 's'}${lib.selected.size ? ` · ${lib.selected.size} selected` : ''}` : '';
    grid.innerHTML = '';
    cells.clear();
    if (!total) {
      grid.appendChild(el('div', { class: 'lib-empty' },
        el('img', { src: 'assets/icon.png', width: 72, height: 72, style: { opacity: 0.9 } }),
        el('h2', {}, 'Welcome to Lumen Studio'),
        el('div', {}, 'Import photos to start. Rate and flag them here, adjust them in Develop, and use layers & tools in Edit.'),
        el('div', { class: 'btn-row' },
          button({ label: 'Import Photos', iconName: 'import', cls: 'primary big', onClick: () => importPhotos() }),
          button({ label: 'Import Folder', iconName: 'folder', cls: 'big', onClick: () => importFolder() }),
          button({ label: 'New Blank Canvas', iconName: 'plus', cls: 'big', onClick: () => app.commands.newDoc() })),
        el('div', { class: 'note' }, 'Tip: you can also drag & drop photos onto this window. JPEG, PNG, WebP, AVIF, TIFF and camera RAW files (via their embedded preview) are supported.')));
      return;
    }
    if (!list.length) {
      grid.appendChild(el('div', { class: 'lib-empty' }, el('div', {}, 'No photos match the current filter.')));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of list) {
      const cell = cellFor(e);
      cells.set(e.id, cell);
      frag.appendChild(cell);
      if (!e._thumbUrl) io.observe(cell);
    }
    grid.appendChild(frag);
  }

  app.catalog.on('change', () => { lib.selected = new Set([...lib.selected].filter((id) => app.catalog.get(id))); render(); });
  app.catalog.on('entry', (e) => {
    const old = cells.get(e.id);
    if (!old) return;
    if (lib.filter.rating || lib.filter.flag !== 'all') { render(); return; }
    const cell = cellFor(e);
    old.replaceWith(cell);
    cells.set(e.id, cell);
    if (!e._thumbUrl) io.observe(cell);
    if (lib.selected.has(e.id)) app.emit('library-selection');
  });
  app.catalog.on('thumb', (e) => {
    const cell = cells.get(e.id);
    if (!cell) return;
    const holder = cell.querySelector('.thumb');
    holder.innerHTML = '';
    holder.appendChild(el('img', { src: e._thumbUrl, draggable: false }));
    const has = e.develop && !isIdentityDevelop(e.develop);
    const ed = cell.querySelector('.edited');
    if (has && !ed) cell.insertBefore(el('span', { class: 'edited' }, icon('sliders', 11)), cell.querySelector('.meta'));
    if (!has && ed) ed.remove();
  });
  app.on('library-filter', render);
  lib.render = render;
  lib.grid = grid;
  render();
}

// ---- keyboard ----
export function libraryKey(e) {
  const list = visibleEntries();
  const sel = selectedEntries();
  const k = e.key;
  if (/^[0-5]$/.test(k) && !e.ctrlKey && !e.altKey) {
    for (const x of sel) app.catalog.update(x.id, { rating: +k });
    if (sel.length) app.status(`Rating: ${'★'.repeat(+k) || 'none'}`);
    return true;
  }
  const lower = k.toLowerCase();
  if (!e.ctrlKey && !e.altKey && (lower === 'p' || lower === 'x' || lower === 'u')) {
    const flag = lower === 'p' ? 1 : lower === 'x' ? -1 : 0;
    for (const x of sel) app.catalog.update(x.id, { flag });
    if (sel.length) app.status(flag === 1 ? 'Flagged as pick' : flag === -1 ? 'Flagged as rejected' : 'Unflagged');
    return true;
  }
  if (k === 'Enter' || (lower === 'd' && !e.ctrlKey)) {
    const target = sel[0] || list[0];
    if (target) openCatalogEntry(target, { module: 'develop' });
    return true;
  }
  if (lower === 'a' && e.ctrlKey) {
    lib.selected = new Set(list.map((x) => x.id));
    lib.render();
    app.emit('library-selection');
    return true;
  }
  if (k === 'Delete' || k === 'Backspace') {
    if (!sel.length) return true;
    removeSelected();
    return true;
  }
  if (k.startsWith('Arrow') && list.length) {
    const cols = Math.max(1, Math.floor((lib.grid.clientWidth - 28 + 12) / (lib.cellSize + 12)));
    let i = list.findIndex((x) => x.id === lib.focus);
    if (i < 0) i = 0;
    else if (k === 'ArrowRight') i++;
    else if (k === 'ArrowLeft') i--;
    else if (k === 'ArrowDown') i += cols;
    else if (k === 'ArrowUp') i -= cols;
    i = Math.max(0, Math.min(list.length - 1, i));
    lib.focus = list[i].id;
    if (e.shiftKey) lib.selected.add(lib.focus); else lib.selected = new Set([lib.focus]);
    lib.render();
    const cell = lib.grid.querySelector(`[data-id="${lib.focus}"]`);
    if (cell) cell.scrollIntoView({ block: 'nearest' });
    app.emit('library-selection');
    return true;
  }
  return false;
}

async function removeSelected() {
  const sel = selectedEntries();
  if (!sel.length) return;
  const r = await messageBox({
    type: 'question',
    message: `Remove ${sel.length} photo${sel.length === 1 ? '' : 's'} from the Library?`,
    detail: 'The original files on disk are not deleted.',
    buttons: ['Remove', 'Cancel'],
    cancelId: 1,
  });
  if (r !== 0) return;
  app.catalog.remove(sel.map((e) => e.id));
  lib.selected.clear();
  app.emit('library-selection');
}

export async function importPhotos() {
  const refs = await pickImages({ multi: true, title: 'Import Photos' });
  if (!refs.length) return;
  await app.catalog.add(refs);
  if (app.module !== 'library') app.setModule('library');
}

export async function importFolder() {
  const refs = await pickFolderImages();
  if (!refs.length) { return; }
  await app.catalog.add(refs);
  if (app.module !== 'library') app.setModule('library');
}

// ---- left & right panels ----

export function buildLibraryLeft(container) {
  const nav = el('div', {});
  const items = [
    ['all', 'All Photographs'],
    ['picked', 'Picks'],
    ['rejected', 'Rejected'],
    ['unflagged', 'Unflagged'],
  ];
  const ratingSel = selectField({
    label: 'Rating ≥', options: [[0, 'Any'], [1, '★'], [2, '★★'], [3, '★★★'], [4, '★★★★'], [5, '★★★★★']],
    value: 0, onChange: (v) => { lib.filter.rating = +v; app.emit('library-filter'); },
  });
  const editedSel = selectField({
    label: 'Show', options: [['all', 'All photos'], ['edited', 'Edited only']], value: 'all',
    onChange: (v) => { lib.filter.edited = v; app.emit('library-filter'); },
  });
  function build() {
    nav.innerHTML = '';
    const c = app.catalog;
    for (const [k, label] of items) {
      const n = k === 'all' ? c.entries.length : c.entries.filter((e) => (k === 'picked' ? e.flag === 1 : k === 'rejected' ? e.flag === -1 : !e.flag)).length;
      const it = el('div', { class: 'nav-item' + (lib.filter.flag === k ? ' active' : '') }, el('span', {}, label), el('span', { class: 'n' }, String(n)));
      it.addEventListener('click', () => { lib.filter.flag = k; build(); app.emit('library-filter'); });
      nav.appendChild(it);
    }
  }
  const root = el('div', { class: 'left-panel panel-stack' },
    el('div', { class: 'panel-scroll' },
      section('Catalog', nav, { id: 'lib-catalog' }),
      section('Filter', el('div', { class: 'lib-filters' }, ratingSel, editedSel), { id: 'lib-filter' }),
      section('Keyboard', el('div', { class: 'note', style: { lineHeight: '1.8' } },
        '0–5  rate · P pick · X reject · U unflag', el('br'), 'Enter  open in Develop', el('br'), 'Ctrl+A  select all · Del  remove'), { id: 'lib-keys', open: false })));
  container.appendChild(root);
  app.catalog.on('change', build);
  app.catalog.on('entry', debounce(build, 100));
  build();
  return root;
}

export function buildLibraryRight(container) {
  const preview = el('div', { class: 'histo', style: { height: '170px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } });
  const info = el('table', { class: 'info-table' });
  const quick = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const presetSel = selectField({
    label: 'Preset', options: [['', 'Choose…'], ...BUILTIN_PRESETS.map((p, i) => [i, p.name])], value: '',
    onChange: (v) => {
      if (v === '') return;
      const p = BUILTIN_PRESETS[+v];
      for (const e of selectedEntries()) app.catalog.setDevelop(e.id, applyPreset(p.settings));
      syncOpenDocs();
      presetSel.set('');
    },
  });
  quick.append(
    presetSel,
    el('div', { class: 'btn-row' },
      button({ label: 'Auto Tone', iconName: 'magic', onClick: () => quickAuto() }),
      button({ label: 'Reset', iconName: 'reset', onClick: () => { for (const e of selectedEntries()) app.catalog.setDevelop(e.id, null); syncOpenDocs(); } })),
    el('div', { class: 'btn-row' },
      button({ label: 'Copy Settings', onClick: () => { const e = focusEntry(); if (e) { app.clipboardDevelop = normalizeDevelop(e.develop); app.status('Settings copied'); } } }),
      button({ label: 'Paste / Sync', title: 'Apply copied settings to all selected photos', onClick: () => {
        if (!app.clipboardDevelop) { app.status('Copy settings first (from a photo or the Develop panel).'); return; }
        for (const e of selectedEntries()) app.catalog.setDevelop(e.id, app.clipboardDevelop);
        syncOpenDocs();
        app.status(`Settings applied to ${selectedEntries().length} photo(s)`);
      } })));
  const actions = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    button({ label: 'Open in Develop', iconName: 'sliders', cls: 'primary', onClick: () => { const e = focusEntry(); if (e) openCatalogEntry(e, { module: 'develop' }); } }),
    button({ label: 'Open in Edit (layers)', iconName: 'layers', onClick: () => { const e = focusEntry(); if (e) openCatalogEntry(e, { module: 'edit' }); } }),
    button({ label: 'Export Selected…', iconName: 'export', onClick: () => batchExportDialog(selectedEntries()) }),
    button({ label: 'Remove from Library', iconName: 'trash', cls: 'danger', onClick: () => removeSelected() }));
  const root = el('div', { class: 'panel-stack' },
    el('div', { class: 'panel-scroll' },
      section('Preview', preview, { id: 'lib-preview' }),
      section('Quick Develop', quick, { id: 'lib-quick' }),
      section('Metadata', info, { id: 'lib-meta' }),
      section('Actions', actions, { id: 'lib-actions' })));
  container.appendChild(root);

  function focusEntry() {
    const sel = selectedEntries();
    return sel.find((e) => e.id === lib.focus) || sel[0] || null;
  }

  async function quickAuto() {
    for (const e of selectedEntries()) {
      try {
        const prev = await app.catalog.preview(e);
        app.catalog.setDevelop(e.id, computeAutoTone(prev, e.develop));
      } catch (err) { console.warn(err); }
    }
    syncOpenDocs();
  }

  function refresh() {
    const e = focusEntry();
    info.innerHTML = '';
    preview.innerHTML = '';
    if (!e) {
      preview.appendChild(el('span', { class: 'note' }, 'No photo selected'));
      return;
    }
    if (e._thumbUrl) preview.appendChild(el('img', { src: e._thumbUrl, style: { maxWidth: '100%', maxHeight: '100%' } }));
    const rows = [['File', e.name]];
    if (e.width) rows.push(['Dimensions', `${e.width} × ${e.height}`]);
    rows.push(...formatExif(e.exif));
    if (e.path) rows.push(['Location', e.path]);
    rows.push(['Rating', '★'.repeat(e.rating || 0) || '–']);
    rows.push(['Flag', e.flag === 1 ? 'Pick' : e.flag === -1 ? 'Rejected' : '–']);
    for (const [a, b] of rows) info.appendChild(el('tr', {}, el('td', {}, a), el('td', {}, b)));
  }
  app.on('library-selection', refresh);
  app.catalog.on('entry', (e) => { if (lib.selected.has(e.id)) refresh(); });
  app.catalog.on('thumb', (e) => { if (lib.selected.has(e.id)) refresh(); });
  refresh();
  return root;
}

// Library-side develop edits should show up in already-open documents.
function syncOpenDocs() {
  for (const d of app.docs) {
    if (!d.catalogId) continue;
    const e = app.catalog.get(d.catalogId);
    const base = d.layers.find((l) => l.linked);
    if (!e || !base) continue;
    const next = normalizeDevelop(e.develop);
    if (JSON.stringify(next) !== JSON.stringify(base.develop)) {
      base.develop = next;
      d.commit('Library Develop');
    }
  }
}

export { openFileRefs };
