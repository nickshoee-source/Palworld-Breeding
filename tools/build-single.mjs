#!/usr/bin/env node
// Bundles the whole app into one self-contained HTML file at dist/palbreeder.html.
//
// Same code and same data as the hosted version, with the scripts, styles and
// all three data payloads inlined so it runs from a local file with no server
// and no network. `npm run build`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = (p) => readFile(join(ROOT, p), 'utf8');

const [html, css, pals, passives, breeding] = await Promise.all([
  text('index.html'),
  text('assets/app.css'),
  text('data/pals.json'),
  text('data/passives.json'),
  text('data/breeding.json'),
]);

const bundled = await build({
  entryPoints: [join(ROOT, 'src/app.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
});
const js = bundled.outputFiles[0].text;

// `</script>` inside a JSON string would close the tag it is sitting in.
const safe = (s) => s.replace(/<\//g, '<\\/');

const out = html
  .replace('<link rel="stylesheet" href="assets/app.css">', `<style>\n${css}\n</style>`)
  .replace(
    '<script type="module" src="src/app.js"></script>',
    `<script>window.__PALDATA__={pals:${safe(pals)},passives:${safe(passives)},breeding:${safe(breeding)}};</script>\n` +
    `<script type="module">\n${js}\n</script>`,
  );

if (out.includes('assets/app.css') || out.includes('src/app.js')) {
  throw new Error('single-file build still references external assets');
}

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist', 'palbreeder.html'), out);
console.log(`dist/palbreeder.html  ${(out.length / 1e6).toFixed(2)} MB`);
