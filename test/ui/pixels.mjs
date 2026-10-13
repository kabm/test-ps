// Pixel-accuracy checks for the rendering engine, run inside Chromium.
import { launch } from './harness.mjs';

const t = await launch({ width: 1200, height: 800 });
const { page } = t;
let failed = 0;

async function check(name, fn) {
  try {
    const r = await page.evaluate(fn);
    if (r !== true) throw new Error(typeof r === 'string' ? r : JSON.stringify(r));
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.log('  ✗', name, '\n     ', e.message.split('\n')[0]);
  }
}

// expose internals through the app object for these tests
await page.evaluate(() => {
  window.__t = {};
});

await check('brush strokes leave no seams on a flat canvas', async () => {
  const { Stroke } = window.__lumenInternals;
  const c = document.createElement('canvas');
  c.width = 300; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#2060ff';
  g.fillRect(0, 0, 300, 200);
  const s = new Stroke({ target: c, mode: 'paint', color: '#2060ff', size: 30, hardness: 0.5, opacity: 1, flow: 1 });
  s.begin({ x: 20, y: 20 });
  for (let i = 0; i < 40; i++) s.add({ x: 20 + i * 6, y: 20 + i * 4 });
  const d = g.getImageData(0, 0, 300, 200).data;
  for (let i = 0; i < d.length; i += 4) {
    // allow +-2 for 8-bit premultiplied rounding; seams were far larger
    if (Math.abs(d[i] - 0x20) > 2 || Math.abs(d[i + 1] - 0x60) > 2 || Math.abs(d[i + 2] - 0xff) > 2 || d[i + 3] !== 255) return `pixel ${i / 4} = ${[...d.slice(i, i + 4)]}`;
  }
  return true;
});

await check('clone stamp on a flat canvas is invisible', async () => {
  const { Stroke } = window.__lumenInternals;
  const c = document.createElement('canvas');
  c.width = 300; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#20a060';
  g.fillRect(0, 0, 300, 200);
  const s = new Stroke({ target: c, mode: 'clone', size: 40, hardness: 0.7, opacity: 1, flow: 1, cloneOffset: { x: -30, y: -10 } });
  s.cloneSource = s.base;
  s.begin({ x: 100, y: 100 });
  for (let i = 0; i < 20; i++) s.add({ x: 100 + i * 5, y: 100 + i * 2 });
  const d = g.getImageData(0, 0, 300, 200).data;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - 0x20) > 2 || Math.abs(d[i + 1] - 0xa0) > 2 || Math.abs(d[i + 2] - 0x60) > 2) return `pixel ${i / 4} = ${[...d.slice(i, i + 4)]}`;
  }
  return true;
});

await check('GPU develop round-trip keeps colors and orientation', async () => {
  const { renderDevelop, defaultDevelop } = window.__lumenInternals;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 48;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, '#fff');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 48);
  g.fillStyle = '#ff0000';
  g.fillRect(0, 0, 16, 8); // red marker top-left
  const s = defaultDevelop();
  s.temp = 1e-6; // forces the GPU path while being visually a no-op
  const out = renderDevelop(c, s);
  const a = g.getImageData(0, 0, 64, 48).data;
  const b = out.getContext('2d').getImageData(0, 0, 64, 48).data;
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  if (max > 3) return 'max channel difference ' + max;
  const tl = [...b.slice(0, 3)];
  if (!(tl[0] > 240 && tl[1] < 15)) return 'top-left should stay red, got ' + tl;
  return true;
});

await check('exposure +1 brightens mid grey by about one stop', async () => {
  const { renderDevelop, defaultDevelop } = window.__lumenInternals;
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(100,100,100)';
  g.fillRect(0, 0, 32, 32);
  const s = defaultDevelop();
  s.exposure = 1;
  const v = renderDevelop(c, s).getContext('2d').getImageData(16, 16, 1, 1).data[0];
  // sRGB 100 -> linear 0.127 -> x2 = 0.254 -> sRGB ~ 137
  if (Math.abs(v - 137) > 4) return 'got ' + v;
  return true;
});

await check('black & white treatment produces neutral pixels', async () => {
  const { renderDevelop, defaultDevelop } = window.__lumenInternals;
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(200,60,30)';
  g.fillRect(0, 0, 16, 16);
  const s = defaultDevelop();
  s.bw = true;
  const d = renderDevelop(c, s).getContext('2d').getImageData(8, 8, 1, 1).data;
  if (Math.abs(d[0] - d[1]) > 1 || Math.abs(d[1] - d[2]) > 1) return 'not neutral: ' + [...d];
  return true;
});

await check('white balance picker neutralises a tinted grey', async () => {
  const { renderDevelop, defaultDevelop, whiteBalanceFromPixel } = window.__lumenInternals;
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(150,128,100)'; // warm grey
  g.fillRect(0, 0, 16, 16);
  const s = { ...defaultDevelop(), ...whiteBalanceFromPixel(c, 8, 8) };
  const d = renderDevelop(c, s).getContext('2d').getImageData(8, 8, 1, 1).data;
  const spread = Math.max(d[0], d[1], d[2]) - Math.min(d[0], d[1], d[2]);
  if (spread > 8) return 'still tinted: ' + [...d] + ' wb ' + JSON.stringify([s.temp, s.tint]);
  return true;
});

await check('spot healing removes a dot from a gradient', async () => {
  const { healArea, makeStamp } = window.__lumenInternals;
  const c = document.createElement('canvas');
  c.width = 200; c.height = 150;
  const g = c.getContext('2d', { willReadFrequently: true });
  const grad = g.createLinearGradient(0, 0, 200, 150);
  grad.addColorStop(0, '#305080');
  grad.addColorStop(1, '#a0c0e0');
  g.fillStyle = grad;
  g.fillRect(0, 0, 200, 150);
  const before = g.getImageData(100, 75, 1, 1).data.slice();
  g.fillStyle = '#ff00ff';
  g.beginPath(); g.arc(100, 75, 6, 0, Math.PI * 2); g.fill();
  const m = document.createElement('canvas');
  m.width = 200; m.height = 150;
  m.getContext('2d').drawImage(makeStamp(26, 0.6), 100 - 14, 75 - 14);
  healArea(c, m, { x: 86, y: 61, w: 28, h: 28 }, 26);
  const after = g.getImageData(100, 75, 1, 1).data;
  const diff = Math.max(...[0, 1, 2].map((k) => Math.abs(after[k] - before[k])));
  if (diff > 12) return `centre differs by ${diff}: ${[...after]} vs ${[...before]}`;
  return true;
});

await check('rotated crop gives the requested size', async () => {
  const app = window.__lumenApp;
  const { newDocument } = window.__lumenInternals;
  newDocument({ width: 400, height: 300, fill: '#808080', name: 'crop-test' });
  window.__lumenInternals.cropTo({ x: 50, y: 40, w: 200, h: 120 }, 10);
  const d = app.doc;
  if (d.width !== 200 || d.height !== 120) return `${d.width}x${d.height}`;
  if (d.layers[0].canvas.width !== 200) return 'layer not cropped';
  return true;
});

await check('undo restores pixels after a fill', async () => {
  const app = window.__lumenApp;
  const { fillWith } = window.__lumenInternals;
  const l = app.doc.layers[0];
  const px = () => [...l.canvas.getContext('2d').getImageData(10, 10, 1, 1).data];
  const p0 = px();
  fillWith('#ff0000');
  const p1 = [...app.doc.layers[0].canvas.getContext('2d').getImageData(10, 10, 1, 1).data];
  app.doc.undo();
  const p2 = [...app.doc.layers[0].canvas.getContext('2d').getImageData(10, 10, 1, 1).data];
  if (p1[0] !== 255 || p1[1] !== 0) return 'fill failed ' + p1;
  if (p2.join() !== p0.join()) return `undo gave ${p2} expected ${p0}`;
  return true;
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall pixel checks passed');
if (t.errors.filter((e) => !/404/.test(e)).length) console.log('errors:', t.errors);
process.exitCode = failed ? 1 : 0;
await t.close();
