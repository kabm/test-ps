// End-to-end scenario exercising the main features in headless Chromium.
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { launch, fixtures, outDir } from './harness.mjs';

const t = await launch();
const { page } = t;
const results = [];

async function step(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('  ✓', name);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    console.log('  ✗', name, '\n     ', e.message.split('\n')[0]);
    await t.shot('fail-' + name.replace(/\W+/g, '-'));
  }
}

const app = (fn, arg) => page.evaluate(fn, arg);
const settle = (ms = 300) => page.waitForTimeout(ms);

async function setSlider(sectionLabel, value) {
  const row = page.locator('.slider-row', { has: page.locator('.slider-label', { hasText: new RegExp(`^${sectionLabel}$`) }) }).first();
  const input = row.locator('.slider-value');
  await input.click();
  await input.fill(String(value));
  await input.press('Enter');
}

async function layerPixelStats(index = -1) {
  return app((i) => {
    const d = window.__lumenApp.doc;
    const l = i < 0 ? d.active : d.layers[i];
    const c = l.canvas;
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    let sum = 0;
    for (let k = 0; k < data.length; k += 4) {
      if (data[k + 3] > 0) opaque++;
      sum += data[k] + data[k + 1] + data[k + 2];
    }
    return { opaque, mean: sum / (data.length / 4) / 3, w: c.width, h: c.height };
  }, index);
}

async function canvasCenterPoint(dx = 0, dy = 0) {
  const box = await page.locator('.viewport-canvas').boundingBox();
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

async function docToClient(x, y) {
  const box = await page.locator('.viewport-canvas').boundingBox();
  const s = await app(([px, py]) => window.__lumenApp.view.docToScreen(px, py), [x, y]);
  return { x: box.x + s.x, y: box.y + s.y };
}

await step('import photos', async () => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.lib-empty .btn.primary')]);
  await chooser.setFiles(['photo.jpg', 'photo2.jpg', 'photo3.tif', 'fake.nef'].map((f) => path.join(fixtures, f)));
  await page.waitForFunction(() => document.querySelectorAll('.lib-cell img').length >= 4, null, { timeout: 20000 });
});

await step('library rating & flag keys', async () => {
  await page.click('.lib-cell >> nth=1');
  await page.keyboard.press('4');
  await page.keyboard.press('p');
  const e = await app(() => window.__lumenApp.catalog.entries[1]);
  assert.equal(e.rating, 4);
  assert.equal(e.flag, 1);
  await t.shot('10-library-rated');
});

await step('open in develop (fitted)', async () => {
  await page.dblclick('.lib-cell >> nth=0');
  await page.waitForFunction(() => window.__lumenApp.doc && document.body.classList.contains('m-develop'), null, { timeout: 20000 });
  await settle(600);
  const z = await app(() => window.__lumenApp.view.view.zoom);
  assert.ok(z > 0.3, 'zoom should fit the photo, got ' + z);
  await t.shot('11-develop-open');
});

await step('exposure slider changes develop + history', async () => {
  const before = await app(() => window.__lumenApp.doc.history.length);
  await setSlider('Exposure', 1);
  await settle();
  const st = await app(() => ({ exp: window.__lumenApp.doc.active.develop.exposure, h: window.__lumenApp.doc.history.length }));
  assert.equal(st.exp, 1);
  assert.equal(st.h, before + 1);
});

await step('develop render changes pixels', async () => {
  const mean = await app(() => {
    const c = window.__lumenApp.view.composite;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4) / 3;
  });
  const raw = await layerPixelStats();
  assert.ok(mean > raw.mean + 10, `developed mean ${mean} should be brighter than source ${raw.mean}`);
});

await step('more basic sliders', async () => {
  await setSlider('Contrast', 30);
  await setSlider('Highlights', -50);
  await setSlider('Shadows', 40);
  await setSlider('Clarity', 25);
  await setSlider('Vibrance', 30);
  await settle(400);
  await t.shot('12-develop-adjusted');
});

await step('preset click + undo', async () => {
  await page.click('.preset-item:has-text("Black & White")');
  await settle(400);
  assert.equal(await app(() => window.__lumenApp.doc.active.develop.bw), true);
  await t.shot('13-preset-bw');
  await page.keyboard.press('Control+z');
  await settle();
  assert.equal(await app(() => window.__lumenApp.doc.active.develop.bw), false);
});

await step('tone curve, HSL, grading, effects sections', async () => {
  for (const name of ['Tone Curve', 'Color Mixer', 'Color Grading', 'Detail', 'Effects']) {
    const head = page.locator('#right .section-head', { hasText: name }).first();
    const open = await head.evaluate((h) => h.parentElement.classList.contains('open'));
    if (!open) await head.click();
  }
  const curve = page.locator('.curve-editor canvas').first();
  await curve.scrollIntoViewIfNeeded();
  const b = await curve.boundingBox();
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.85, { steps: 4 });
  await page.mouse.up();
  const pts = await app(() => window.__lumenApp.doc.active.develop.curve.master.length);
  assert.equal(pts, 3);
  const wheel = page.locator('.wheel canvas').first();
  await wheel.scrollIntoViewIfNeeded();
  const wb = await wheel.boundingBox();
  await page.mouse.click(wb.x + wb.width * 0.8, wb.y + wb.height * 0.5);
  const s = await app(() => window.__lumenApp.doc.active.develop.grading.shadows.s);
  assert.ok(s > 30, 'shadow grading saturation set');
  await setSlider('Vignette', -40);
  await setSlider('Grain', 20);
  await settle(400);
  await t.shot('14-develop-sections');
});

await step('auto tone', async () => {
  await page.keyboard.press('Control+u');
  await settle();
  const last = await app(() => window.__lumenApp.doc.history.at(-1).label);
  assert.equal(last, 'Auto Tone');
});

await step('library thumbnail reflects develop', async () => {
  await page.waitForTimeout(800);
  const dev = await app(() => !!window.__lumenApp.catalog.entries[0].develop);
  assert.ok(dev, 'catalog entry has develop settings');
});

await step('switch to edit + new layer + brush stroke', async () => {
  await page.click('#modules button[data-module="edit"]');
  await settle();
  await page.keyboard.press('Control+Shift+N');
  await settle();
  assert.equal(await app(() => window.__lumenApp.doc.layers.length), 2);
  await page.keyboard.press('b');
  await app(() => { window.__lumenApp.fg = '#ff2040'; window.__lumenApp.brush.size = 60; });
  const a = await canvasCenterPoint(-150, 0);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 300, a.y + 80, { steps: 20 });
  await page.mouse.up();
  const st = await layerPixelStats();
  assert.ok(st.opaque > 1000, 'brush painted pixels: ' + st.opaque);
  await t.shot('20-edit-brush');
});

await step('marquee + delete clears pixels', async () => {
  await page.keyboard.press('m');
  const before = (await layerPixelStats()).opaque;
  const a = await canvasCenterPoint(-60, -60);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 120, a.y + 160, { steps: 5 });
  await page.mouse.up();
  assert.ok(await app(() => !!window.__lumenApp.doc.selection));
  await page.keyboard.press('Delete');
  const after = (await layerPixelStats()).opaque;
  assert.ok(after < before, `pixels cleared ${before} -> ${after}`);
  await t.shot('21-selection-cleared');
  await page.keyboard.press('Control+d');
});

await step('layer mask + gradient on mask', async () => {
  await app(() => window.__lumenApp.doc.setActive(window.__lumenApp.doc.layers[0]));
  await page.click('.layers-toolbar button[title^="Add layer mask"]');
  assert.ok(await app(() => !!window.__lumenApp.doc.layers[0].mask));
  assert.ok(await app(() => window.__lumenApp.maskEditing));
  await page.keyboard.press('g');
  const tool = await app(() => window.__lumenApp.toolId);
  assert.equal(tool, 'gradient');
  const a = await canvasCenterPoint(-200, 0);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 400, a.y, { steps: 6 });
  await page.mouse.up();
  await t.shot('22-mask-gradient');
  // disable mask again for later checks
  await app(() => { const l = window.__lumenApp.doc.layers[0]; l.maskEnabled = false; window.__lumenApp.doc.commit('Disable Mask'); window.__lumenApp.maskEditing = false; });
});

await step('text tool', async () => {
  await page.keyboard.press('t');
  const a = await canvasCenterPoint(-250, -200);
  await page.mouse.click(a.x, a.y);
  await settle(200);
  await page.keyboard.type('Hello Lumen');
  await page.keyboard.press('Escape');
  await settle();
  const txt = await app(() => window.__lumenApp.doc.layers.filter((l) => l.type === 'text').map((l) => l.text.text));
  assert.deepEqual(txt, ['Hello Lumen']);
  await t.shot('23-text');
});

await step('free transform (Ctrl+T) scales the layer', async () => {
  await page.keyboard.press('v');
  const idx = await app(() => window.__lumenApp.doc.layers.findIndex((l) => l.type === 'raster' && !l.linked));
  await app((i) => window.__lumenApp.doc.setActive(window.__lumenApp.doc.layers[i]), idx);
  const w0 = (await layerPixelStats()).w;
  await page.keyboard.press('Control+t');
  await settle();
  const d = await app(() => ({ w: window.__lumenApp.doc.width, h: window.__lumenApp.doc.height }));
  const se = await docToClient(d.w, d.h);
  await page.mouse.move(se.x, se.y);
  await page.mouse.down();
  await page.mouse.move(se.x - 200, se.y - 150, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await settle();
  const w1 = (await layerPixelStats()).w;
  assert.ok(w1 < w0, `layer scaled ${w0} -> ${w1}`);
  await t.shot('24-transform');
});

await step('filter dialog (Gaussian blur) applies', async () => {
  await app(() => window.__lumenApp.doc.setActive(window.__lumenApp.doc.layers[0]));
  await page.click('.menu-root > button:has-text("Filter")');
  await page.locator('.menu-item.has-sub > span', { hasText: /^Blur$/ }).hover();
  await page.getByText('Gaussian Blur\u2026', { exact: true }).click();
  await page.waitForSelector('.modal');
  await settle(400);
  await t.shot('25-filter-dialog');
  await page.click('.modal .btn.primary');
  await settle();
  const last = await app(() => window.__lumenApp.doc.history.at(-1).label);
  assert.equal(last, 'Gaussian Blur');
});

await step('image adjustments: hue/saturation via menu', async () => {
  await page.click('.menu-root > button:has-text("Image")');
  await page.locator('.menu-item.has-sub > span', { hasText: /^Adjustments$/ }).hover();
  await page.getByText('Hue/Saturation\u2026', { exact: true }).click();
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  await settle();
});

await step('crop tool reduces document size', async () => {
  await page.keyboard.press('c');
  await settle();
  const d0 = await app(() => ({ w: window.__lumenApp.doc.width, h: window.__lumenApp.doc.height }));
  const nw = await docToClient(0, 0);
  await page.mouse.move(nw.x, nw.y);
  await page.mouse.down();
  await page.mouse.move(nw.x + 120, nw.y + 90, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await settle(500);
  const d1 = await app(() => ({ w: window.__lumenApp.doc.width, h: window.__lumenApp.doc.height }));
  assert.ok(d1.w < d0.w && d1.h < d0.h, `cropped ${JSON.stringify(d0)} -> ${JSON.stringify(d1)}`);
  await t.shot('26-cropped');
});

await step('undo/redo through history panel', async () => {
  const n = await app(() => window.__lumenApp.doc.historyIndex);
  await page.keyboard.press('Control+z');
  assert.equal(await app(() => window.__lumenApp.doc.historyIndex), n - 1);
  await page.keyboard.press('Control+y');
  assert.equal(await app(() => window.__lumenApp.doc.historyIndex), n);
});

await step('rotate & flip', async () => {
  const d0 = await app(() => ({ w: window.__lumenApp.doc.width, h: window.__lumenApp.doc.height }));
  await app(() => window.__lumenApp.view && null);
  await page.click('.menu-root > button:has-text("Image")');
  await page.locator('.menu-item.has-sub > span', { hasText: /^Rotate & Flip$/ }).hover();
  await page.getByText('Rotate 90\u00b0 Clockwise', { exact: true }).click();
  const d1 = await app(() => ({ w: window.__lumenApp.doc.width, h: window.__lumenApp.doc.height }));
  assert.deepEqual(d1, { w: d0.h, h: d0.w });
  await page.keyboard.press('Control+z');
});

await step('export JPEG (download)', async () => {
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector('.modal');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.modal .btn.primary')]);
  const p = path.join(outDir, 'export-' + dl.suggestedFilename());
  await dl.saveAs(p);
  const size = fs.statSync(p).size;
  assert.ok(size > 10000, 'exported size ' + size);
});

await step('save project and reopen it', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const p = path.join(outDir, 'project-' + dl.suggestedFilename());
  await dl.saveAs(p);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(json.format, 'lumen-project');
  const layers = await app(() => window.__lumenApp.doc.layers.length);
  assert.equal(json.layers.length, layers);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
  const lumenPath = p.replace(/\.lumen$/, '') + '-reopen.lumen';
  fs.copyFileSync(p, lumenPath);
  await chooser.setFiles(lumenPath);
  await page.waitForFunction((n) => window.__lumenApp.docs.length >= 2 && window.__lumenApp.doc.layers.length === n, layers, { timeout: 15000 });
  await settle(500);
  await t.shot('27-reopened-project');
});

await step('new blank document + paint bucket', async () => {
  await app(() => window.__lumenApp.commands.newDoc());
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  await settle();
  await page.keyboard.press('Shift+g');
  await app(() => window.__lumenApp.setTool('bucket'));
  await app(() => { window.__lumenApp.fg = '#2060ff'; });
  const c = await canvasCenterPoint();
  await page.mouse.click(c.x, c.y);
  const st = await layerPixelStats();
  assert.ok(st.mean < 200, 'bucket filled with blue, mean ' + st.mean);
});

await step('clone stamp & spot heal run', async () => {
  // paint a dot then heal it
  await page.keyboard.press('b');
  await app(() => { window.__lumenApp.fg = '#ffffff'; window.__lumenApp.brush.size = 20; });
  const c = await canvasCenterPoint();
  await page.mouse.click(c.x, c.y);
  await page.keyboard.press('j');
  await app(() => { window.__lumenApp.brush.size = 40; });
  await page.mouse.move(c.x - 5, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 5, c.y, { steps: 3 });
  await page.mouse.up();
  const last = await app(() => window.__lumenApp.doc.history.at(-1).label);
  assert.equal(last, 'Spot Healing');
  await page.keyboard.press('s');
  await page.keyboard.down('Alt');
  await page.mouse.click(c.x - 100, c.y - 100);
  await page.keyboard.up('Alt');
  await page.mouse.move(c.x + 50, c.y + 50);
  await page.mouse.down();
  await page.mouse.move(c.x + 90, c.y + 70, { steps: 5 });
  await page.mouse.up();
  assert.equal(await app(() => window.__lumenApp.doc.history.at(-1).label), 'Clone Stamp');
});

await step('magic wand & lasso', async () => {
  await page.keyboard.press('w');
  const c = await canvasCenterPoint(80, 80);
  await page.mouse.click(c.x, c.y);
  assert.ok(await app(() => !!window.__lumenApp.doc.selection));
  await page.keyboard.press('l');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y, { steps: 3 });
  await page.mouse.move(c.x + 60, c.y + 60, { steps: 3 });
  await page.mouse.move(c.x, c.y + 60, { steps: 3 });
  await page.mouse.up();
  await t.shot('28-selection');
});

await step('close docs and go back to library', async () => {
  page.on('dialog', (d) => d.accept());
  await app(async () => {
    for (const d of [...window.__lumenApp.docs]) {
      await window.__lumenInternals.closeDoc(d, { force: true });
    }
  });
  assert.equal(await app(() => window.__lumenApp.docs.length), 0);
  await page.click('#modules button[data-module="library"]');
  await settle(800);
  await t.shot('29-library-end');
});

const relevantErrors = t.errors.filter((e) => !/favicon|404/.test(e));
console.log('\nconsole errors:', relevantErrors.length ? relevantErrors : 'none');
const failed = results.filter((r) => r[0] !== 'ok');
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length || relevantErrors.length) process.exitCode = 1;
await t.close();
