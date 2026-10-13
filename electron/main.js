'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, nativeTheme, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const fsp = fs.promises;

const IMAGE_EXTS = [
  'jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff', 'heic', 'heif',
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'raf', 'pef', 'srw', 'x3f', 'erf', 'kdc', '3fr', 'mef', 'mos', 'iiq', 'rwl',
];
const PROJECT_EXT = 'lumen';

let mainWindow = null;
let pendingOpenPaths = [];
let allowClose = false;

nativeTheme.themeSource = 'dark';

function filesFromArgv(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => a && !a.startsWith('-'))
    .filter((a) => {
      const ext = path.extname(a).slice(1).toLowerCase();
      return IMAGE_EXTS.includes(ext) || ext === PROJECT_EXT;
    })
    .filter((a) => {
      try { return fs.statSync(a).isFile(); } catch { return false; }
    });
}

function userFile(name) {
  return path.join(app.getPath('userData'), name);
}

async function writeFileAtomic(target, data) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target);
}

async function listImagesRecursive(dir, depth = 0, out = []) {
  if (depth > 6 || out.length > 20000) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await listImagesRecursive(full, depth + 1, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) out.push(full);
    }
  }
  return out;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#1b1b1d',
    title: 'Lumen Studio',
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenu(null);

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // Keep all navigation inside the app.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12' && input.control && input.shift) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Ask the renderer before closing so unsaved work is not lost.
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:close-requested');
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

// ---------- IPC ----------

ipcMain.handle('dialog:open', async (_e, opts = {}) => {
  const properties = [];
  if (opts.directory) properties.push('openDirectory');
  else properties.push('openFile');
  if (opts.multi) properties.push('multiSelections');
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
    properties,
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:save', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('dialog:message', async (_e, opts = {}) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: opts.type || 'question',
    title: opts.title || 'Lumen Studio',
    message: opts.message || '',
    detail: opts.detail,
    buttons: opts.buttons || ['OK'],
    defaultId: opts.defaultId || 0,
    cancelId: opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 0),
    noLink: true,
  });
  return res.response;
});

ipcMain.handle('fs:read', async (_e, p) => {
  const buf = await fsp.readFile(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

ipcMain.handle('fs:write', async (_e, p, data) => {
  await writeFileAtomic(p, Buffer.from(data));
  return true;
});

ipcMain.handle('fs:stat', async (_e, p) => {
  try {
    const s = await fsp.stat(p);
    return { size: s.size, mtime: s.mtimeMs, isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return null;
  }
});

ipcMain.handle('fs:listImages', async (_e, dir) => listImagesRecursive(dir));

ipcMain.handle('store:load', async (_e, name) => {
  if (!/^[a-z0-9_-]+\.json$/i.test(name)) throw new Error('bad store name');
  try {
    return await fsp.readFile(userFile(name), 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('store:save', async (_e, name, text) => {
  if (!/^[a-z0-9_-]+\.json$/i.test(name)) throw new Error('bad store name');
  await writeFileAtomic(userFile(name), text);
  return true;
});

ipcMain.handle('thumbs:read', async (_e, id) => {
  if (!/^[a-z0-9_-]+$/i.test(id)) return null;
  try {
    const buf = await fsp.readFile(path.join(userFile('thumbs'), id + '.jpg'));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
});

ipcMain.handle('thumbs:write', async (_e, id, data) => {
  if (!/^[a-z0-9_-]+$/i.test(id)) return false;
  await writeFileAtomic(path.join(userFile('thumbs'), id + '.jpg'), Buffer.from(data));
  return true;
});

// Decode formats Chromium can't read (HEIC/HEIF) with the codecs installed in Windows
// (WIC via WPF). Paths are passed through environment variables to avoid quoting issues.
const OS_DECODE_PS = [
  'Add-Type -AssemblyName PresentationCore',
  '$in = [System.IO.File]::OpenRead($env:LUMEN_SRC)',
  'try {',
  '  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($in, [System.Windows.Media.Imaging.BitmapCreateOptions]::None, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)',
  '  $enc = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder',
  '  $enc.QualityLevel = 97',
  '  $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($dec.Frames[0]))',
  '  $out = [System.IO.File]::Create($env:LUMEN_DST)',
  '  try { $enc.Save($out) } finally { $out.Close() }',
  '} finally { $in.Close() }',
].join('\n');

ipcMain.handle('image:osDecode', async (_e, data, ext) => {
  if (process.platform !== 'win32') throw new Error('HEIC/HEIF photos can only be opened on Windows.');
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'img';
  const dir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'lumen-'));
  const src = path.join(dir, 'in.' + safeExt);
  const dst = path.join(dir, 'out.jpg');
  try {
    await fsp.writeFile(src, Buffer.from(data));
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', OS_DECODE_PS], {
        env: { ...process.env, LUMEN_SRC: src, LUMEN_DST: dst },
        windowsHide: true,
        timeout: 120000,
      }, (err, _stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve()));
    });
    const out = await fsp.readFile(dst);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (err) {
    throw new Error('Windows could not decode this photo. Install "HEIF Image Extensions" and "HEVC Video Extensions" from the Microsoft Store, then try again.\n\n' + err.message);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

ipcMain.handle('clipboard:writeImage', async (_e, pngData) => {
  const img = nativeImage.createFromBuffer(Buffer.from(pngData));
  clipboard.writeImage(img);
  return true;
});

ipcMain.handle('clipboard:readImage', async () => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  const png = img.toPNG();
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
});

ipcMain.handle('app:launchFiles', async () => {
  const files = pendingOpenPaths;
  pendingOpenPaths = [];
  return files;
});

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath('userData'),
  pictures: app.getPath('pictures'),
  electron: process.versions.electron,
}));

ipcMain.on('app:set-title', (_e, title) => {
  if (mainWindow && typeof title === 'string') mainWindow.setTitle(title);
});

ipcMain.on('app:close-confirmed', () => {
  allowClose = true;
  if (mainWindow) mainWindow.close();
});

ipcMain.on('app:toggle-fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingOpenPaths = filesFromArgv(process.argv);

  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length) mainWindow.webContents.send('app:open-files', files);
    }
  });

  app.whenReady().then(() => {
    // Allow the Local Font Access API so the Text tool can list installed fonts.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'local-fonts' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      permission === 'local-fonts' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
