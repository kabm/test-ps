// Shared helpers for UI tests: static server + headless Chromium with WebGL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const outDir = path.join(root, 'test/ui/output');
export const fixtures = path.join(root, 'test/fixtures');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

export function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Uses CHROMIUM_PATH, then a pre-installed Playwright Chromium, then Playwright's own
// download (run `npx playwright-core install chromium` first in that case).
export function chromePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    const dir = fs.readdirSync(base).find((d) => /^chromium-\d+$/.test(d));
    if (dir) return path.join(base, dir, 'chrome-linux/chrome');
  }
  return undefined;
}

export async function launch({ width = 1600, height = 960 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width, height }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  const url = `http://127.0.0.1:${server.address().port}/src/index.html`;
  await page.goto(url);
  await page.waitForFunction(() => window.__lumenReady === true, null, { timeout: 20000 });
  return {
    page, browser, server, errors,
    async shot(name) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(outDir, name + '.png') });
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}
