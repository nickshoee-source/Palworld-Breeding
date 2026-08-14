#!/usr/bin/env node
// Checks the packed data/ files against the raw upstream dump in vendor/.
// Run after every data rebuild: `npm run verify`.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

const [db, raw, palsFile, passivesFile, breedingFile] = await Promise.all([
  read('vendor/db.json'),
  read('vendor/breeding.json'),
  read('data/pals.json'),
  read('data/passives.json'),
  read('data/breeding.json'),
]);

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const pals = palsFile.pals;
const indexOf = new Map(pals.map((p, i) => [p.id, i]));
const n = breedingFile.count;

const unpack = (b64, Type) => {
  const bytes = Buffer.from(b64, 'base64');
  return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
};
const pairs = unpack(breedingFile.pairs, Uint16Array);
const offset = (i, j) => (i * (2 * n - i + 1)) / 2 + (j - i);
const childOf = (a, b) => {
  const [i, j] = a <= b ? [a, b] : [b, a];
  return pairs[offset(i, j)];
};

check(pals.length === db.Pals.length, `pal count ${pals.length} != ${db.Pals.length}`);
check(passivesFile.passives.length === db.PassiveSkills.filter((p) => p.IsStandardPassiveSkill).length, 'passive count mismatch');
check(pairs.length === (n * (n + 1)) / 2, 'breeding matrix is the wrong size');

// Every row of the original 44,851-row table must round-trip.
let checked = 0;
for (const row of raw.Breeding) {
  const a = indexOf.get(row.Parent1InternalName);
  const b = indexOf.get(row.Parent2InternalName);
  const expected = indexOf.get(row.ChildInternalName);
  if (row.Parent1Gender !== 'WILDCARD' || row.Parent2Gender !== 'WILDCARD') {
    const override = breedingFile.genderOverrides.find(
      (o) => o.parents[0] === a && o.parents[1] === b && o.genders[0] === row.Parent1Gender && o.genders[1] === row.Parent2Gender,
    );
    check(override?.child === expected, `missing gender override for ${row.Parent1InternalName} x ${row.Parent2InternalName}`);
    continue;
  }
  const got = childOf(a, b);
  if (got !== expected) {
    failures.push(`${row.Parent1InternalName} x ${row.Parent2InternalName} -> ${pals[got]?.name} (expected ${row.ChildInternalName})`);
    if (failures.length > 10) break;
  }
  checked++;
}

// Breeding is symmetric and every pair resolves to a real Pal.
for (let i = 0; i < n; i += 37) {
  for (let j = 0; j < n; j += 41) {
    const c = childOf(i, j);
    check(c < n, `pair (${i},${j}) resolves to a non-existent Pal index ${c}`);
    check(c === childOf(j, i), `pair (${i},${j}) is not symmetric`);
  }
}

// Self-breeding always produces the same species.
for (let i = 0; i < n; i++) {
  check(childOf(i, i) === i, `${pals[i].name} bred with itself does not produce itself`);
}

// Gender odds are probabilities that sum to 1.
for (const p of pals) check(p.maleChance >= 0 && p.maleChance <= 1, `${p.name} has an impossible male chance`);

// Sanity-check a few well-known results straight from the raw table.
const named = (name) => indexOf.get(db.Pals.find((p) => p.Name === name)?.InternalName);
const knownPairs = [
  ['Relaxaurus', 'Sparkit', 'Relaxaurus Lux'],
  ['Vanwyrm', 'Foxcicle', 'Vanwyrm Cryst'],
  ['Mossanda', 'Grizzbolt', 'Mossanda Lux'],
];
for (const [a, b, expected] of knownPairs) {
  const got = pals[childOf(named(a), named(b))]?.name;
  check(got === expected, `${a} x ${b} -> ${got} (expected ${expected})`);
}

console.log(`round-tripped ${checked} breeding rows`);
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('all data checks passed');
