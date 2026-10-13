// Renders build/icon.svg to PNGs using Chromium (dev helper).
// Usage: node scripts/render-icon.mjs build/icon.svg build
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const svg = fs.readFileSync(process.argv[2], 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
for (const size of [512, 256]) {
  await page.setViewportSize({ width: size, height: size });
  await page.evaluate((s) => { const el = document.querySelector('svg'); el.setAttribute('width', s); el.setAttribute('height', s); }, size);
  const buf = await page.locator('svg').screenshot({ omitBackground: true });
  fs.writeFileSync(`${process.argv[3]}/icon-${size}.png`, buf);
}
await browser.close();
