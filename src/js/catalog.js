// The Library catalog: imported photos with ratings, flags and develop settings.

import { app } from './app.js';
import { Emitter, uid, fitSize, resizeCanvas, canvasToBlob, debounce, deepClone, canvasFromImage } from './util.js';
import { decodeImage, exifDate } from './imageio.js';
import { renderDevelop, isIdentityDevelop, normalizeDevelop } from './develop.js';
import {
  storeLoad, storeSave, thumbRead, thumbWrite, fileRefFromPath, isDesktop, extOf, RAW_EXTS,
} from './platform.js';

const PREVIEW_EDGE = 720;

export class Catalog extends Emitter {
  constructor() {
    super();
    this.entries = [];
    this.byId = new Map();
    this.queue = [];
    this.active = 0;
    this.saveSoon = debounce(() => this.save(), 600);
    this.thumbSoon = new Map();
  }

  async load() {
    try {
      const text = await storeLoad('catalog.json');
      if (text) {
        const data = JSON.parse(text);
        for (const e of data.entries || []) {
          e.develop = e.develop ? normalizeDevelop(e.develop) : null;
          this.entries.push(e);
          this.byId.set(e.id, e);
        }
      }
    } catch (e) {
      console.error('catalog load failed', e);
    }
    this.emit('change');
  }

  async save() {
    if (!isDesktop) return; // browser mode keeps the catalog in memory only
    const entries = this.entries.map((e) => {
      const o = {};
      for (const [k, v] of Object.entries(e)) if (!k.startsWith('_')) o[k] = v;
      return o;
    });
    await storeSave('catalog.json', JSON.stringify({ version: 1, entries }));
  }

  get(id) {
    return this.byId.get(id);
  }

  async add(refs) {
    const added = [];
    const out = [];
    for (const ref of refs) {
      const key = ref.path || null;
      let e = key ? this.entries.find((x) => x.path === key) : null;
      if (!e) {
        e = {
          id: uid('p'),
          path: ref.path || '',
          name: ref.name,
          addedAt: Date.now(),
          captureDate: 0,
          exif: null,
          rating: 0,
          flag: 0,
          develop: null,
          width: 0,
          height: 0,
          isRaw: RAW_EXTS.includes(extOf(ref.name)),
        };
        this.entries.push(e);
        this.byId.set(e.id, e);
        added.push(e);
      }
      if (!e.path || !isDesktop) e._ref = ref;
      e.missing = false;
      out.push(e);
    }
    if (added.length) {
      this.emit('change');
      this.saveSoon();
      app.status(`Imported ${added.length} photo${added.length === 1 ? '' : 's'}`);
    }
    return out;
  }

  remove(ids) {
    const set = new Set(ids);
    this.entries = this.entries.filter((e) => !set.has(e.id));
    for (const id of ids) {
      const e = this.byId.get(id);
      if (e && e._thumbUrl) URL.revokeObjectURL(e._thumbUrl);
      this.byId.delete(id);
    }
    this.emit('change');
    this.saveSoon();
  }

  update(id, patch) {
    const e = this.byId.get(id);
    if (!e) return;
    Object.assign(e, patch);
    this.emit('entry', e);
    this.saveSoon();
  }

  setDevelop(id, settings) {
    const e = this.byId.get(id);
    if (!e) return;
    const next = settings ? deepClone(settings) : null;
    if (JSON.stringify(next) === JSON.stringify(e.develop)) return;
    e.develop = next;
    this.saveSoon();
    this.invalidateThumb(e);
  }

  invalidateThumb(e) {
    clearTimeout(this.thumbSoon.get(e.id));
    this.thumbSoon.set(e.id, setTimeout(async () => {
      if (!e._preview) return;
      await this.renderThumb(e);
      this.emit('thumb', e);
    }, 250));
  }

  ref(e) {
    if (e._ref) return e._ref;
    if (e.path && isDesktop) return fileRefFromPath(e.path);
    return null;
  }

  async loadFull(e, opts = {}) {
    const ref = this.ref(e);
    if (!ref) throw new Error('The original file is not available.');
    let buf;
    try {
      buf = await ref.read();
    } catch {
      e.missing = true;
      this.emit('entry', e);
      throw new Error('The original file could not be found:\n' + (e.path || e.name));
    }
    const res = await decodeImage(buf, e.name, opts);
    if (!opts.maxEdge) {
      const patch = { width: res.canvas.width, height: res.canvas.height };
      if (res.exif) {
        patch.exif = res.exif;
        patch.captureDate = exifDate(res.exif) || e.captureDate;
      }
      this.update(e.id, patch);
    } else if (res.exif && !e.exif) {
      this.update(e.id, { exif: res.exif, captureDate: exifDate(res.exif) });
    }
    return res;
  }

  // Lazily produce the thumbnail URL for an entry.
  thumb(e) {
    if (e._thumbUrl) return Promise.resolve(e._thumbUrl);
    if (e._thumbPromise) return e._thumbPromise;
    e._thumbPromise = new Promise((resolve) => {
      this.queue.push({ e, resolve });
      this.pump();
    });
    return e._thumbPromise;
  }

  pump() {
    while (this.active < 3 && this.queue.length) {
      const { e, resolve } = this.queue.shift();
      this.active++;
      this.makeThumb(e)
        .then((url) => resolve(url))
        .catch((err) => {
          console.warn('thumb failed', e.name, err);
          e._error = err.message;
          resolve(null);
        })
        .finally(() => {
          this.active--;
          e._thumbPromise = null;
          this.pump();
        });
    }
  }

  async preview(e) {
    if (e._preview) return e._preview;
    // cached undeveloped preview on disk?
    const cached = await thumbRead(e.id);
    if (cached) {
      try {
        const bmp = await createImageBitmap(cached);
        e._preview = canvasFromImage(bmp);
        bmp.close?.();
        return e._preview;
      } catch { /* regenerate */ }
    }
    const res = await this.loadFull(e, { maxEdge: 4096 });
    const f = fitSize(res.canvas.width, res.canvas.height, PREVIEW_EDGE);
    e._preview = resizeCanvas(res.canvas, f.w, f.h);
    if (!e.width) this.update(e.id, { width: res.canvas.width, height: res.canvas.height });
    thumbWrite(e.id, await canvasToBlob(e._preview, 'image/jpeg', 0.85)).catch(() => {});
    return e._preview;
  }

  async renderThumb(e) {
    const prev = await this.preview(e);
    let c = prev;
    if (e.develop && !isIdentityDevelop(e.develop)) {
      try {
        c = renderDevelop(prev, e.develop, { refW: e.width || prev.width, refH: e.height || prev.height });
      } catch (err) {
        console.warn(err);
      }
    }
    const blob = await canvasToBlob(c, 'image/jpeg', 0.85);
    if (e._thumbUrl) URL.revokeObjectURL(e._thumbUrl);
    e._thumbUrl = URL.createObjectURL(blob);
    e._thumbCanvas = c;
    return e._thumbUrl;
  }

  async makeThumb(e) {
    return this.renderThumb(e);
  }

  // Developed full-resolution canvas for export.
  async renderFull(e) {
    const res = await this.loadFull(e);
    if (e.develop && !isIdentityDevelop(e.develop)) {
      return renderDevelop(res.canvas, e.develop);
    }
    return res.canvas;
  }
}
