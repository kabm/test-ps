// Smoke-tests a packaged build (e.g. dist/win-unpacked/LumenStudio.exe on Windows CI):
// the app must start, initialise WebGL, open a document and run the develop pipeline.
// Usage: node test/ui/packaged-smoke.mjs [path-to-executable]
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { root, outDir } from './harness.mjs';

const exe = process.argv[2] || path.join(root, 'dist/win-unpacked/LumenStudio.exe');
if (!fs.existsSync(exe)) {
  console.error('Executable not found:', exe);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-packaged-'));

const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`] });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
let failed = false;
try {
  await win.waitForFunction(() => window.__lumenReady === true, null, { timeout: 60000 });
  console.log('  ✓ app started');
  const result = await win.evaluate(() => {
    const I = window.__lumenInternals;
    I.newDocument({ width: 640, height: 400, fill: '#808080', name: 'smoke' });
    const s = I.defaultDevelop();
    s.exposure = 1;
    const out = I.renderDevelop(window.__lumenApp.doc.layers[0].canvas, s);
    const px = out.getContext('2d').getImageData(10, 10, 1, 1).data;
    return { title: document.title, px: [...px] };
  });
  assert.ok(result.px[0] > 150, 'develop brightened the grey canvas: ' + result.px);
  console.log('  ✓ WebGL develop pipeline works', result.px.join(','));
  if (process.platform === 'win32') {
    // The OS-codec path (used for HEIC) must work: decode a PNG through Windows' WIC.
    const head = await win.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 24;
      c.getContext('2d').fillRect(0, 0, 32, 24);
      const png = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
      const out = await window.lumen.osDecode(png, 'png');
      return [out[0], out[1], out.length];
    });
    assert.equal(head[0], 0xff, 'JPEG SOI expected, got ' + head);
    assert.equal(head[1], 0xd8);
    console.log('  \u2713 Windows codec bridge (WIC) decodes images');
  }
  await win.waitForTimeout(1000);
  await win.screenshot({ path: path.join(outDir, 'packaged-app.png') });
  console.log('  ✓ screenshot saved');
} catch (e) {
  failed = true;
  console.error('  ✗', e.message);
  await win.screenshot({ path: path.join(outDir, 'packaged-app-failure.png') }).catch(() => {});
}
if (errors.length) console.log('renderer errors:', errors);
await app.close().catch(() => {});
fs.rmSync(userData, { recursive: true, force: true });
process.exitCode = failed || errors.length ? 1 : 0;
