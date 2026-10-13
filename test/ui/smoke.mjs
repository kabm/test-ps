// Quick smoke run: load the app, import photos, open one in Develop, take screenshots.
import path from 'node:path';
import { launch, fixtures } from './harness.mjs';

const t = await launch();
const { page } = t;
try {
  await t.shot('01-library-empty');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.lib-empty .btn.primary'),
  ]);
  await chooser.setFiles(['photo.jpg', 'photo2.jpg', 'photo3.tif', 'fake.nef', 'logo.png'].map((f) => path.join(fixtures, f)));
  await page.waitForFunction(() => document.querySelectorAll('.lib-cell img').length >= 5, null, { timeout: 20000 });
  await t.shot('02-library-grid');
  await page.dblclick('.lib-cell >> nth=0');
  await page.waitForFunction(() => window.__lumenApp.doc && document.body.classList.contains('m-develop'), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await t.shot('03-develop');
  console.log('errors:', t.errors.length ? t.errors : 'none');
} catch (e) {
  console.error('FAILED', e);
  await t.shot('99-failure');
  console.log('errors:', t.errors);
  process.exitCode = 1;
} finally {
  await t.close();
}
