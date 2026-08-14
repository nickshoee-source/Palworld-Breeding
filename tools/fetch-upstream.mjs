#!/usr/bin/env node
// Downloads the upstream Palworld game-data dumps into vendor/.
//
// Source: tylercamp/palcalc (MIT), which generates these files directly from the
// game's own data tables. `db.json` carries the Pal list, stats, work suitability
// and passive-skill definitions; `breeding.json` is the complete parent-pair ->
// child table extracted from the game (44,851 rows).
//
// vendor/ is gitignored. Run `npm run data` to refresh vendor/ and regenerate data/.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/tylercamp/palcalc/main/PalCalc.Model';
const FILES = ['db.json', 'breeding.json'];

await mkdir(join(ROOT, 'vendor'), { recursive: true });

for (const file of FILES) {
  const url = `${BASE}/${file}`;
  process.stdout.write(`fetching ${url} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  await writeFile(join(ROOT, 'vendor', file), body);
  console.log(`${(body.length / 1e6).toFixed(2)} MB`);
}

console.log('done. now run: node tools/build-data.mjs');
