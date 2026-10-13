// Bundles the renderer (src/js) into src/bundle/app.js with esbuild.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'src/js/main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  outfile: path.join(root, 'src/bundle/app.js'),
  sourcemap: 'linked',
  minify: process.argv.includes('--minify'),
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
  // UTIF probes for `require`; keep it bundled.
  platform: 'browser',
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching...');
} else {
  await build(options);
}
