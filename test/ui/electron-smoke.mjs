// Launches the real Electron app (needs a display: run under xvfb-run on Linux CI)
// and checks the desktop bridge: file reading, catalog persistence, thumbnails,
// project saving and the close-confirmation flow.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { root, fixtures, outDir } from './harness.mjs';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
fs.mkdirSync(outDir, { recursive: true });
const electronPath = (await import('electron')).default;

async function start() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', `--user-data-dir=${userData}`, root],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForFunction(() => window.__lumenReady === true, null, { timeout: 30000 });
  return { app, win, errors };
}

let failed = 0;
const ok = (name) => console.log('  ✓', name);
const bad = (name, e) => { failed++; console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); };

// --- first launch ---
let { app, win, errors } = await start();
try {
  assert.equal(await win.evaluate(() => typeof window.lumen), 'object');
  assert.equal(await win.evaluate(() => typeof window.require), 'undefined');
  ok('preload bridge present, node integration off');
} catch (e) { bad('preload bridge', e); }

try {
  const files = ['photo.jpg', 'photo2.jpg', 'fake.nef', 'photo3.tif'].map((f) => path.join(fixtures, f));
  await win.evaluate(async (paths) => {
    const I = window.__lumenInternals;
    await window.__lumenApp.catalog.add(paths.map((p) => I.fileRefFromPath(p)));
  }, files);
  await win.waitForFunction(() => document.querySelectorAll('.lib-cell img').length >= 4, null, { timeout: 30000 });
  ok('imports photos from disk paths via IPC');
} catch (e) { bad('import from disk', e); }

try {
  await win.dblclick('.lib-cell >> nth=0');
  await win.waitForFunction(() => window.__lumenApp.doc && document.body.classList.contains('m-develop'), null, { timeout: 20000 });
  await win.evaluate(() => {
    const l = window.__lumenApp.doc.active;
    l.develop.exposure = 0.7;
    l.develop.vibrance = 25;
    window.__lumenApp.doc.commit('Test develop');
  });
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(outDir, 'electron-develop.png') });
  ok('opens a photo in Develop and applies settings');
} catch (e) { bad('develop', e); }

const projectPath = path.join(userData, 'saved-project.lumen');
try {
  await win.evaluate(async (p) => {
    const I = window.__lumenInternals;
    await I.writeFile(p, await I.serializeProject(window.__lumenApp.doc));
  }, projectPath);
  const json = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  assert.equal(json.format, 'lumen-project');
  ok('writes a project file to disk');
} catch (e) { bad('save project', e); }

try {
  // catalog is saved with a debounce; trigger it now
  await win.evaluate(() => window.__lumenApp.catalog.save());
  const cat = JSON.parse(fs.readFileSync(path.join(userData, 'catalog.json'), 'utf8'));
  assert.equal(cat.entries.length, 4);
  const e0 = cat.entries.find((e) => e.name === 'photo.jpg');
  assert.equal(e0.develop.exposure, 0.7);
  const thumbs = fs.readdirSync(path.join(userData, 'thumbs'));
  assert.ok(thumbs.length >= 4, 'thumbnail cache files: ' + thumbs.length);
  ok('catalog + thumbnail cache persisted in userData');
} catch (e) { bad('catalog persistence', e); }

try {
  // closing: develop-only edits need no prompt, so the window should close
  const closed = new Promise((r) => app.on('close', r));
  await win.evaluate(() => window.close());
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('window did not close')), 10000))]);
  ok('window closes without prompting for develop-only edits');
} catch (e) {
  bad('close flow', e);
  await app.close().catch(() => {});
}

// --- second launch: catalog should be restored ---
({ app, win, errors: errors } = await start());
try {
  const n = await win.evaluate(() => window.__lumenApp.catalog.entries.length);
  assert.equal(n, 4);
  await win.waitForFunction(() => document.querySelectorAll('.lib-cell img').length >= 4, null, { timeout: 30000 });
  await win.screenshot({ path: path.join(outDir, 'electron-library-restored.png') });
  ok('library restored on next launch');
} catch (e) { bad('restore', e); }

try {
  await win.evaluate(async (p) => {
    await window.__lumenInternals.openFileRefs([window.__lumenInternals.fileRefFromPath(p)]);
  }, projectPath);
  await win.waitForFunction(() => window.__lumenApp.doc && window.__lumenApp.doc.layers.length >= 1, null, { timeout: 20000 });
  ok('reopens a saved project');
} catch (e) { bad('reopen project', e); }

if (errors.length) console.log('renderer errors:', errors);
await app.close().catch(() => {});
fs.rmSync(userData, { recursive: true, force: true });
console.log(failed ? `\n${failed} electron check(s) failed` : '\nall electron checks passed');
process.exitCode = failed || errors.length ? 1 : 0;
