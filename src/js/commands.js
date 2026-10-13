// Document management & file I/O: new/open/close/save/export.

import { app } from './app.js';
import { Doc, Layer } from './document.js';
import { createCanvas, canvasToBlob, blobToDataURL, dataURLToCanvas, resizeCanvas, fitSize } from './util.js';
import { decodeImage, encodeTiff } from './imageio.js';
import { flatten } from './render.js';
import {
  extOf, stripExt, baseName, pickImages, pickSavePath, writeFile, messageBox, PROJECT_FILTERS, setTitle,
} from './platform.js';
import { normalizeDevelop, isIdentityDevelop } from './develop.js';

export function activateDoc(doc) {
  app.doc = doc;
  app.previews.clear();
  app.maskEditing = false;
  if (doc && !doc.view && app.view) app.view.fit();
  app.emit('doc', doc);
  app.render();
  updateTitle();
}

export function updateTitle() {
  const d = app.doc;
  setTitle(d ? `${d.name}${d.dirty ? ' *' : ''} – Lumen Studio` : 'Lumen Studio');
}

function registerDoc(doc) {
  doc.initHistory('Open');
  doc.dirty = false;
  doc.on('change', () => {
    app.render();
    app.emit('doc-change', doc);
  });
  doc.on('history', () => {
    syncCatalog(doc);
    updateTitle();
  });
  app.docs.push(doc);
  activateDoc(doc);
  if (app.module === 'library') app.setModule(doc.catalogId ? 'develop' : 'edit');
  return doc;
}

// Push the linked layer's develop settings back to the library entry.
export function syncCatalog(doc) {
  if (!doc.catalogId || !app.catalog) return;
  const base = doc.layers.find((l) => l.linked);
  if (!base) return;
  app.catalog.setDevelop(doc.catalogId, isIdentityDevelop(base.develop) ? null : base.develop);
}

export function newDocument({ width, height, fill = '#ffffff', name = 'Untitled' }) {
  const d = new Doc({ width, height, name });
  const c = createCanvas(width, height);
  if (fill) {
    const g = c.getContext('2d');
    g.fillStyle = fill;
    g.fillRect(0, 0, width, height);
  }
  const l = new Layer({ name: 'Background', canvas: c });
  d.addLayer(l);
  return registerDoc(d);
}

export function newDocumentFromCanvas(canvas, name, extra = {}) {
  const d = new Doc({ width: canvas.width, height: canvas.height, name });
  const l = new Layer({ name: 'Background', canvas, develop: extra.develop, linked: !!extra.catalogId });
  d.addLayer(l);
  d.catalogId = extra.catalogId || null;
  d.sourcePath = extra.sourcePath || null;
  d.exif = extra.exif || null;
  d.originalCanvas = canvas;
  return registerDoc(d);
}

export async function openFileRefs(refs) {
  if (!refs || !refs.length) return;
  const projects = refs.filter((r) => extOf(r.name) === 'lumen');
  const images = refs.filter((r) => extOf(r.name) !== 'lumen');
  for (const p of projects) {
    try {
      await openProject(p);
    } catch (e) {
      console.error(e);
      messageBox({ type: 'error', message: `Could not open ${p.name}`, detail: e.message });
    }
  }
  if (images.length) {
    const entries = await app.catalog.add(images);
    // open up to 10 of them as documents
    const toOpen = entries.slice(0, 10);
    for (const e of toOpen) await openCatalogEntry(e);
  }
}

export async function openDialog() {
  const refs = await pickImages({ multi: true, includeProjects: true, title: 'Open' });
  await openFileRefs(refs);
}

export async function openCatalogEntry(entry, { module } = {}) {
  const existing = app.docs.find((d) => d.catalogId === entry.id);
  if (existing) {
    activateDoc(existing);
    if (module) app.setModule(module);
    return existing;
  }
  app.emit('busy', true, `Opening ${entry.name}…`);
  try {
    const { canvas, exif, note } = await app.catalog.loadFull(entry);
    const d = newDocumentFromCanvas(canvas, entry.name, {
      catalogId: entry.id, develop: entry.develop, sourcePath: entry.path, exif,
    });
    if (note) app.status(note, 6000);
    if (module) app.setModule(module);
    return d;
  } catch (e) {
    console.error(e);
    messageBox({ type: 'error', message: `Could not open ${entry.name}`, detail: e.message });
    return null;
  } finally {
    app.emit('busy', false);
  }
}

export async function openImageBuffer(buffer, name) {
  const { canvas, exif } = await decodeImage(buffer, name);
  return newDocumentFromCanvas(canvas, name, { exif });
}

function docNeedsSave(d) {
  if (!d.dirty) return false;
  if (d.filePath) return true;
  if (d.catalogId) {
    // develop-only changes are stored in the library automatically
    const onlyBase = d.layers.length === 1 && d.layers[0].linked && d.layers[0].canvas === d.originalCanvas && !d.layers[0].mask;
    return !onlyBase;
  }
  return d.history.length > 1;
}

export async function closeDoc(doc = app.doc, { force = false } = {}) {
  if (!doc) return true;
  if (!force && docNeedsSave(doc)) {
    activateDoc(doc);
    const r = await messageBox({
      type: 'warning',
      message: `Save changes to “${doc.name}” before closing?`,
      detail: 'Layer and pixel edits are kept in a Lumen project file (.lumen).',
      buttons: ['Save', "Don't Save", 'Cancel'],
      cancelId: 2,
    });
    if (r === 2) return false;
    if (r === 0) {
      const ok = await saveProject(doc);
      if (!ok) return false;
    }
  }
  syncCatalog(doc);
  const i = app.docs.indexOf(doc);
  if (i >= 0) app.docs.splice(i, 1);
  if (app.doc === doc) activateDoc(app.docs[Math.min(i, app.docs.length - 1)] || null);
  app.emit('docs');
  if (!app.docs.length && app.module !== 'library') app.setModule('library');
  return true;
}

export async function closeAll() {
  for (const d of [...app.docs]) {
    const ok = await closeDoc(d);
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Projects (.lumen): JSON with PNG layers

export async function serializeProject(d) {
  const layers = [];
  for (const l of d.layers) {
    const o = {
      type: l.type, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y,
      develop: l.develop, text: l.text, maskEnabled: l.maskEnabled, linked: l.linked,
    };
    if (l.canvas) o.image = await blobToDataURL(await canvasToBlob(l.canvas, 'image/png'));
    if (l.mask) o.mask = await blobToDataURL(await canvasToBlob(l.mask, 'image/png'));
    layers.push(o);
  }
  return JSON.stringify({
    format: 'lumen-project', version: 1, app: 'Lumen Studio',
    width: d.width, height: d.height, name: d.name, sourcePath: d.sourcePath,
    activeIndex: d.activeIndex, layers,
  });
}

export async function deserializeProject(text, name) {
  const p = JSON.parse(text);
  if (p.format !== 'lumen-project') throw new Error('Not a Lumen project file.');
  const d = new Doc({ width: p.width, height: p.height, name: name || p.name || 'Project' });
  for (const o of p.layers) {
    const l = new Layer({
      type: o.type, name: o.name, visible: o.visible, opacity: o.opacity, blend: o.blend, x: o.x, y: o.y,
      develop: o.develop, text: o.text, maskEnabled: o.maskEnabled,
      canvas: o.image ? await dataURLToCanvas(o.image) : null,
      mask: o.mask ? await dataURLToCanvas(o.mask) : null,
    });
    d.layers.push(l);
  }
  const active = d.layers[p.activeIndex] || d.layers[d.layers.length - 1];
  d.activeId = active ? active.id : null;
  d.sourcePath = p.sourcePath || null;
  return d;
}

export async function openProject(ref) {
  const existing = app.docs.find((d) => d.filePath && d.filePath === ref.path);
  if (existing) { activateDoc(existing); return existing; }
  app.emit('busy', true, `Opening ${ref.name}…`);
  try {
    const buf = await ref.read();
    const d = await deserializeProject(new TextDecoder().decode(buf), stripExt(ref.name));
    d.filePath = ref.path || null;
    registerDoc(d);
    if (app.module !== 'edit') app.setModule('edit');
    return d;
  } finally {
    app.emit('busy', false);
  }
}

export async function saveProject(d = app.doc, saveAs = false) {
  if (!d) return false;
  let path = d.filePath;
  if (!path || saveAs) {
    path = await pickSavePath({ title: 'Save Project', defaultName: stripExt(d.name) + '.lumen', filters: PROJECT_FILTERS });
    if (!path) return false;
  }
  app.emit('busy', true, 'Saving…');
  try {
    const text = await serializeProject(d);
    await writeFile(path, text);
    if (!path.startsWith('::download::')) {
      d.filePath = path;
      d.name = stripExt(baseName(path));
    }
    d.dirty = false;
    updateTitle();
    app.emit('docs');
    app.status('Saved ' + baseName(path.replace('::download::', '')));
    return true;
  } catch (e) {
    messageBox({ type: 'error', message: 'Could not save the project.', detail: e.message });
    return false;
  } finally {
    app.emit('busy', false);
  }
}

// ---------------------------------------------------------------------------
// Export

export const EXPORT_FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
  png: { mime: 'image/png', ext: 'png', label: 'PNG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
  tiff: { mime: 'image/tiff', ext: 'tif', label: 'TIFF' },
};

// opts: { format, quality (0-1), maxEdge (0 = original), scale }
export async function encodeForExport(canvas, opts) {
  let c = canvas;
  if (opts.maxEdge && Math.max(c.width, c.height) > opts.maxEdge) {
    const f = fitSize(c.width, c.height, opts.maxEdge);
    c = resizeCanvas(c, f.w, f.h);
  } else if (opts.scale && opts.scale !== 1) {
    c = resizeCanvas(c, c.width * opts.scale, c.height * opts.scale);
  }
  const fmt = EXPORT_FORMATS[opts.format] || EXPORT_FORMATS.jpeg;
  if (opts.format === 'jpeg') {
    // JPEG has no transparency: composite onto white
    const o = createCanvas(c.width, c.height);
    const g = o.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, o.width, o.height);
    g.drawImage(c, 0, 0);
    c = o;
  }
  if (opts.format === 'tiff') {
    return new Blob([encodeTiff(c)], { type: 'image/tiff' });
  }
  return canvasToBlob(c, fmt.mime, opts.quality ?? 0.92);
}

export async function exportDoc(d, opts, path) {
  const canvas = flatten(d);
  const blob = await encodeForExport(canvas, opts);
  await writeFile(path, blob);
  return blob.size;
}

export async function quickExport(d = app.doc) {
  if (!d) return;
  const path = await pickSavePath({
    title: 'Export JPEG', defaultName: stripExt(d.name) + '.jpg',
    filters: [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }],
  });
  if (!path) return;
  app.emit('busy', true, 'Exporting…');
  try {
    await exportDoc(d, { format: 'jpeg', quality: 0.92 }, path);
    app.status('Exported ' + baseName(path.replace('::download::', '')));
  } finally {
    app.emit('busy', false);
  }
}

export { normalizeDevelop };
