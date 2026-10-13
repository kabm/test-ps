// Abstraction over the desktop (Electron) bridge with a browser fallback,
// so the editor can also run (and be tested) as a plain web page.

const api = typeof window !== 'undefined' ? window.lumen : undefined;
export const isDesktop = !!api;

export const IMAGE_EXTS = [
  'jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'heif',
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'raf', 'pef', 'srw', 'x3f', 'erf', 'kdc', '3fr', 'mef', 'mos', 'iiq', 'rwl',
];
export const RAW_EXTS = IMAGE_EXTS.slice(IMAGE_EXTS.indexOf('dng'));

export const IMAGE_FILTERS = [
  { name: 'Images', extensions: IMAGE_EXTS },
  { name: 'All Files', extensions: ['*'] },
];
export const PROJECT_FILTERS = [{ name: 'Lumen Project', extensions: ['lumen'] }];

export function extOf(name) {
  const m = /\.([^.\\/]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function baseName(p) {
  return (p || '').split(/[\\/]/).pop();
}

export function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

// A FileRef is { name, path, read(): Promise<ArrayBuffer> }
function refFromPath(p) {
  return {
    name: baseName(p),
    path: p,
    read: async () => {
      const u8 = await api.readFile(p);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    },
  };
}

function refFromFile(file) {
  const p = isDesktop ? api.pathForFile(file) : '';
  return {
    name: file.name,
    path: p || '',
    file,
    read: () => file.arrayBuffer(),
  };
}

export function fileRefFromPath(p) {
  return refFromPath(p);
}

export function fileRefsFromDrop(fileList) {
  return Array.from(fileList).map(refFromFile);
}

function browserPick(accept, multiple, directory) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = !!multiple;
    if (directory) input.webkitdirectory = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    input.addEventListener('change', () => {
      done = true;
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files.map(refFromFile));
    });
    // Resolve empty if the dialog is cancelled.
    window.addEventListener('focus', () => setTimeout(() => {
      if (!done) { input.remove(); resolve([]); }
    }, 800), { once: true });
    input.click();
  });
}

export async function pickImages({ multi = true, title = 'Open Images', includeProjects = false } = {}) {
  if (isDesktop) {
    const filters = includeProjects
      ? [{ name: 'Images & Projects', extensions: [...IMAGE_EXTS, 'lumen'] }, ...IMAGE_FILTERS]
      : IMAGE_FILTERS;
    const paths = await api.openDialog({ title, multi, filters });
    return paths.map(refFromPath);
  }
  const accept = IMAGE_EXTS.map((e) => '.' + e).join(',') + (includeProjects ? ',.lumen' : '');
  return browserPick(accept, multi, false);
}

export async function pickFolderImages() {
  if (isDesktop) {
    const [dir] = await api.openDialog({ title: 'Import Folder', directory: true });
    if (!dir) return [];
    const paths = await api.listImages(dir);
    return paths.map(refFromPath);
  }
  const refs = await browserPick('', true, true);
  return refs.filter((r) => IMAGE_EXTS.includes(extOf(r.name)));
}

export async function pickDirectory(title = 'Choose Folder') {
  if (isDesktop) {
    const [dir] = await api.openDialog({ title, directory: true });
    return dir || null;
  }
  return '::downloads::';
}

export async function pickSavePath({ title, defaultName, filters }) {
  if (isDesktop) {
    return api.saveDialog({ title, defaultPath: defaultName, filters });
  }
  return '::download::' + defaultName;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function joinPath(dir, name) {
  if (dir === '::downloads::') return '::download::' + name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

// data: ArrayBuffer | Uint8Array | Blob | string
export async function writeFile(path, data) {
  let u8;
  if (data instanceof Blob) u8 = new Uint8Array(await data.arrayBuffer());
  else if (typeof data === 'string') u8 = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
  else u8 = data;
  if (path.startsWith('::download::')) {
    downloadBlob(new Blob([u8]), path.slice('::download::'.length));
    return true;
  }
  return api.writeFile(path, u8);
}

export async function fileExists(path) {
  if (!isDesktop || !path) return false;
  const s = await api.stat(path);
  return !!(s && s.isFile);
}

export async function storeLoad(name) {
  if (isDesktop) return api.storeLoad(name);
  try { return localStorage.getItem('lumen:' + name); } catch { return null; }
}

export async function storeSave(name, text) {
  if (isDesktop) return api.storeSave(name, text);
  try { localStorage.setItem('lumen:' + name, text); } catch { /* quota */ }
  return true;
}

export async function thumbRead(id) {
  if (!isDesktop) return null;
  const u8 = await api.thumbRead(id);
  return u8 ? new Blob([u8], { type: 'image/jpeg' }) : null;
}

export async function thumbWrite(id, blob) {
  if (!isDesktop) return;
  await api.thumbWrite(id, new Uint8Array(await blob.arrayBuffer()));
}

// Decode an image with the operating system's codecs (used for HEIC/HEIF). Returns JPEG bytes.
export async function osDecode(buffer, ext) {
  if (!isDesktop) throw new Error('HEIC/HEIF photos can be opened in the Windows desktop app.');
  const u8 = await api.osDecode(new Uint8Array(buffer), ext);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export async function clipboardWriteImage(pngBlob) {
  if (isDesktop) {
    await api.clipboardWriteImage(new Uint8Array(await pngBlob.arrayBuffer()));
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  } catch { /* not permitted */ }
}

export async function clipboardReadImage() {
  if (isDesktop) {
    const u8 = await api.clipboardReadImage();
    return u8 ? new Blob([u8], { type: 'image/png' }) : null;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) return it.getType(type);
    }
  } catch { /* not permitted */ }
  return null;
}

export async function messageBox({ message, detail, buttons = ['OK'], type = 'question', cancelId }) {
  if (isDesktop) return api.messageBox({ message, detail, buttons, type, cancelId });
  if (buttons.length <= 1) { window.alert(message + (detail ? '\n\n' + detail : '')); return 0; }
  return window.confirm(message + (detail ? '\n\n' + detail : '')) ? 0 : (cancelId ?? buttons.length - 1);
}

export function setTitle(t) {
  if (isDesktop) api.setTitle(t);
  else document.title = t;
}

export function onOpenFiles(cb) {
  if (isDesktop) api.onOpenFiles((paths) => cb(paths.map(refFromPath)));
}

export async function launchFiles() {
  if (!isDesktop) return [];
  const paths = await api.launchFiles();
  return paths.map(refFromPath);
}

export function onCloseRequested(cb) {
  if (isDesktop) api.onCloseRequested(cb);
}

export function confirmClose() {
  if (isDesktop) api.confirmClose();
}

export function toggleFullscreen() {
  if (isDesktop) api.toggleFullscreen();
  else if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

export async function appInfo() {
  if (isDesktop) return api.info();
  return { version: 'web', platform: 'web' };
}
