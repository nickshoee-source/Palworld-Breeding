#!/usr/bin/env node
// Turns the upstream dumps in vendor/ into the compact files in data/ that the
// app actually ships.
//
//   data/pals.json      - one entry per Pal: stats, work suitability, gender odds
//   data/passives.json  - the 115 real passive skills, with parsed effects
//   data/breeding.json  - the complete parent-pair -> child table, packed
//
// The breeding table is a dense upper-triangular matrix. Every one of the
// 44,850 unordered species pairs has exactly one entry (plus one gender-split
// pair, Katress x Wixen, which is kept aside as an override), so there is no
// need to store parent names per row: pair (i <= j) lives at a computed offset
// and holds a uint16 child index. That packs the whole 8.9 MB table into ~90 KB.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

const db = await read('vendor/db.json');
const breedingRaw = await read('vendor/breeding.json');

/* ------------------------------------------------------------------ pals */

// Display order: Paldex number, base form before its variants.
const pals = [...db.Pals].sort(
  (a, b) => a.Id.PalDexNo - b.Id.PalDexNo || Number(a.Id.IsVariant) - Number(b.Id.IsVariant) || a.Name.localeCompare(b.Name),
);
const indexOf = new Map(pals.map((p, i) => [p.InternalName, i]));

const WORK_TYPES = [
  ['Kindling', 'Kindling'],
  ['Watering', 'Watering'],
  ['Planting', 'Planting'],
  ['GenerateElectricity', 'Electricity'],
  ['Handiwork', 'Handiwork'],
  ['Gathering', 'Gathering'],
  ['Lumbering', 'Lumbering'],
  ['Mining', 'Mining'],
  ['MedicineProduction', 'Medicine'],
  ['Cooling', 'Cooling'],
  ['Transporting', 'Transporting'],
  ['Farming', 'Farming'],
];

/* --------------------------------------------------------------- passives */

const ELEMENT_ALIAS = { Lightning: 'Electric', Earth: 'Ground' };
const el = (name) => ELEMENT_ALIAS[name] ?? name;

// Every distinct line that appears in an English passive description is matched
// by exactly one of these rules. Anything unmatched fails the build loudly, so a
// game update that adds new wording gets noticed instead of silently ignored.
const RULES = [
  [/^Attack ([+-]\d+)%$/, (m) => [['attack', +m[1]]]],
  [/^Defense ([+-]\d+)%$/, (m) => [['defense', +m[1]]]],
  [/^(\d+)% increase to defense\.?$/, (m) => [['defense', +m[1]]]],
  [/^Work Speed ([+-]\d+)%$/, (m) => [['workSpeed', +m[1]]]],
  [/^Movement Speed \+(\d+)%$/, (m) => [['moveSpeed', +m[1]]]],
  [/^Movement Speed increases (\d+)%$/, (m) => [['moveSpeed', +m[1]]]],
  [/^(\d+)% increase to movement speed\.?$/, (m) => [['moveSpeed', +m[1]]]],
  [/^(\d+)% increase movement speed on water\.?$/, (m) => [['waterMoveSpeed', +m[1]]]],
  [/^Max Health -(\d+)%$/, (m) => [['maxHp', -m[1]]]],
  [/^HP -(\d+)%$/, (m) => [['maxHp', -m[1]]]],
  [/^Max [Ss]tamina ([+-]\d+)%$/, (m) => [['maxStamina', +m[1]]]],
  [/^Hunger decreases \+([\d.]+)% slower\.?$/, (m) => [['hungerSaved', +m[1]]]],
  [/^Hunger decreases \+([\d.]+)% faster\.?$/, (m) => [['hungerSaved', -m[1]]]],
  [/^Decrease Hunger depletion rate by \+([\d.]+)%$/, (m) => [['hungerSaved', +m[1]]]],
  [/^Increases Hunger depletion rate by \+([\d.]+)%$/, (m) => [['hungerSaved', -m[1]]]],
  [/^SAN (?:drops|dreceases) \+([\d.]+)% slower\.?$/, (m) => [['sanSaved', +m[1]]]],
  [/^SAN (?:drops|dreceases) \+([\d.]+)% faster\.?$/, (m) => [['sanSaved', -m[1]]]],
  [/^SAN depletion rate -([\d.]+)%$/, (m) => [['sanSaved', +m[1]]]],
  [/^Active skill cooldown reduction (\d+)%$/, (m) => [['cooldown', +m[1]]]],
  [/^Active skill cooldown extension -(\d+)%$/, (m) => [['cooldown', -m[1]]]],
  [/^(\d+)% increase (?:in|to) (\w+) attack damage\.?$/, (m) => [[`elemAtk:${el(m[2])}`, +m[1]]]],
  [/^(\d+)% decrease in incoming (\w+) damage\.?$/, (m) => [[`elemRes:${el(m[2])}`, +m[1]]]],
  [/^(\w+) damage reduction (\d+)%$/, (m) => [[`elemRes:${el(m[1])}`, +m[2]]]],
  [/^(\d+)% increase in Player Attack\.?$/, (m) => [['playerAttack', +m[1]]]],
  [/^(\d+)% increase in Player Defense\.?$/, (m) => [['playerDefense', +m[1]]]],
  [/^(\d+)% increase in Player Work Speed\.?$/, (m) => [['playerWorkSpeed', +m[1]]]],
  [/^(\d+)% increase in Player Mining Efficiency\.?$/, (m) => [['playerMining', +m[1]]]],
  [/^(\d+)% increase in Player Logging Efficiency\.?$/, (m) => [['playerLogging', +m[1]]]],
  [/^Player Stamina Consumption -([\d.]+)%$/, (m) => [['playerStamina', +m[1]]]],
  [/^Player Reload Speed \+(\d+)%$/, (m) => [['playerReload', +m[1]]]],
  [/^Player Auto Health Regeneration Rate \+(\d+)%$/, (m) => [['playerRegen', +m[1]]]],
  [/^Pal Auto Health Regeneration Rate \+(\d+)%$/, (m) => [['palRegen', +m[1]]]],
  [/^Pal and Player Auto Health Regeneration Rate \+(\d+)%$/, (m) => [['palRegen', +m[1]], ['playerRegen', +m[1]]]],
  [/^Life Steal \+(\d+)%$/, (m) => [['lifeSteal', +m[1]]]],
  [/^Absorbs a portion of the damage dealt to restore Health\.$/, () => [['lifeSteal', 5]]],
  [/^Immune to (\w+) Damage$/, (m) => [[`immune:${m[1]}`, 1]]],
  [/^Immune to Flinch$/, () => [['immune:Flinch', 1]]],
  [/^Immune to Knockback$/, () => [['immune:Knockback', 1]]],
  [/^Farming's Work Suitability \+(\d+)$/, (m) => [['farmingSuitability', +m[1]]]],
  [/^Mounted Jump Count \+(\d+)$/, (m) => [['mountedJump', +m[1]]]],
  [/^Your Dropped Items \+ (\d+)%$/, (m) => [['dropRate', +m[1]]]],
  [/^Increases the value of items when sold by \+(\d+)%$/, (m) => [['itemValue', +m[1]]]],
  [/^Decrease the value of items when sold by -(\d+)%$/, (m) => [['itemValue', -m[1]]]],
  [/^When assigned to a Breeding Farm, breeding speed is increased by (\d+)%\.$/, (m) => [['breedSpeed', +m[1]]]],
  [/^While at a base, increases egg production speed by \+(\d+)% and incubation speed by \+(\d+)% for Pals assigned to a Breeding Farm\.$/, (m) => [['eggSpeed', +m[1]], ['incubationSpeed', +m[2]]]],
  [/^Does not sleep (?:at night and continues to work|and continues to work even at night)\.$/, () => [['worksAtNight', 1]]],
  [/^Tends to nap through the day, due to being nocturnal\.$/, () => [['sleepsInDay', 1]]],
  [/^Pacifist\.$/, () => [['pacifist', 1]]],
  [/^Will not reduce the target's Health below 1\.$/, () => []],
  [/^World Tree (?:harvestables won't|resources will not) vanish when approached\.$/, () => [['worldTreeHarvest', 1]]],
  [/^\*This effect is only valid for rideable pals\.$/, () => [['rideOnly', 1]]],
];

function parseEffects(description, passiveName) {
  const effects = {};
  for (const raw of (description ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const rule = RULES.find(([re]) => re.test(line));
    if (!rule) throw new Error(`unparsed effect line on "${passiveName}": ${JSON.stringify(line)}`);
    for (const [key, value] of rule[1](line.match(rule[0]))) {
      effects[key] = (effects[key] ?? 0) + value;
    }
  }
  return effects;
}

const passives = db.PassiveSkills.filter((p) => p.IsStandardPassiveSkill).map((p) => ({
  name: p.Name,
  id: p.InternalName,
  rank: p.Rank,
  description: p.Description ?? '',
  effects: parseEffects(p.Description, p.Name),
  // A passive that is not randomly inheritable can only ever reach a child from a
  // parent that already has it. That makes it the single most important planning
  // fact in the app, so it is a first-class field.
  randomInheritable: p.RandomInheritanceAllowed === true,
  // Rare random rolls (weight 5) vs the common pool (weight 100).
  randomWeight: p.RandomInheritanceWeight,
  surgeryItem: p.SurgeryRequiredItem ?? null,
}));

const passiveById = new Map(passives.map((p) => [p.id, p]));

/* ------------------------------------------------- pals, second pass */

const unresolvedGuaranteed = new Set();
const palsOut = pals.map((p) => {
  const guaranteed = (p.GuaranteedPassivesInternalIds ?? []).filter((id) => {
    if (passiveById.has(id)) return true;
    unresolvedGuaranteed.add(id);
    return false;
  });
  const work = {};
  for (const [key, label] of WORK_TYPES) {
    const level = p.WorkSuitability?.[key] ?? 0;
    if (level > 0) work[label] = level;
  }
  return {
    name: p.Name,
    id: p.InternalName,
    dex: p.Id.PalDexNo,
    variant: p.Id.IsVariant,
    breedingPower: p.BreedingPower,
    rarity: p.Rarity,
    size: p.Size,
    nocturnal: p.Nocturnal,
    hp: p.Hp,
    attack: p.Attack,
    defense: p.Defense,
    runSpeed: p.RunSpeed,
    rideSprintSpeed: p.RideSprintSpeed,
    transportSpeed: p.TransportSpeed,
    stamina: p.Stamina,
    craftSpeed: p.CraftSpeed,
    work,
    // Probability that a hatched egg of this species is male.
    maleChance: db.BreedingGenderProbability[p.InternalName]?.MALE ?? 0.5,
    minWildLevel: p.MinWildLevel,
    maxWildLevel: p.MaxWildLevel,
    guaranteed,
  };
});

if (unresolvedGuaranteed.size) {
  console.warn(`note: ${unresolvedGuaranteed.size} guaranteed-passive ids are not standard passives and were dropped`);
}

/* ------------------------------------------------------------- breeding */

const n = pals.length;
// Offset of pair (i, j) with i <= j in the flattened upper triangle.
const offset = (i, j) => (i * (2 * n - i + 1)) / 2 + (j - i);
const table = new Uint16Array((n * (n + 1)) / 2).fill(0xffff);

const genderOverrides = [];
let filled = 0;

for (const row of breedingRaw.Breeding) {
  const a = indexOf.get(row.Parent1InternalName);
  const b = indexOf.get(row.Parent2InternalName);
  const child = indexOf.get(row.ChildInternalName);
  if (a === undefined || b === undefined || child === undefined) {
    throw new Error(`breeding row references an unknown Pal: ${JSON.stringify(row)}`);
  }
  if (row.Parent1Gender !== 'WILDCARD' || row.Parent2Gender !== 'WILDCARD') {
    genderOverrides.push({
      parents: [a, b],
      genders: [row.Parent1Gender, row.Parent2Gender],
      child,
    });
    continue;
  }
  const [i, j] = a <= b ? [a, b] : [b, a];
  const slot = offset(i, j);
  if (table[slot] !== 0xffff && table[slot] !== child) {
    throw new Error(`conflicting breeding results for ${row.Parent1InternalName} x ${row.Parent2InternalName}`);
  }
  if (table[slot] === 0xffff) filled++;
  table[slot] = child;
}

// Pairs covered only by a gender override still need a default result, or the
// matrix would have a hole. Katress x Wixen is the only such pair: it yields
// Katress Ignis or Wixen Noct depending on which parent is female, so the
// default is left as the first override and the UI explains the split.
for (const o of genderOverrides) {
  const [i, j] = o.parents[0] <= o.parents[1] ? o.parents : [o.parents[1], o.parents[0]];
  const slot = offset(i, j);
  if (table[slot] === 0xffff) {
    table[slot] = o.child;
    filled++;
  }
}

const holes = table.reduce((acc, v) => acc + (v === 0xffff ? 1 : 0), 0);
if (holes) throw new Error(`breeding matrix has ${holes} uncovered species pairs`);

// The upstream dump also carries a MinBreedingSteps table, but it counts steps
// for a line started from a single species in isolation, which is not the
// question the solver asks. Distances are derived from the packed matrix at
// runtime instead, so that table is deliberately not shipped.

/* ----------------------------------------------------------------- write */

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

await mkdir(join(ROOT, 'data'), { recursive: true });

await writeFile(
  join(ROOT, 'data', 'pals.json'),
  JSON.stringify({ version: db.Version, workTypes: WORK_TYPES.map(([, label]) => label), pals: palsOut }),
);
await writeFile(join(ROOT, 'data', 'passives.json'), JSON.stringify({ version: db.Version, passives }));
await writeFile(
  join(ROOT, 'data', 'breeding.json'),
  JSON.stringify({
    version: db.Version,
    count: n,
    // uint16 child index per (i <= j) pair, little-endian, base64
    pairs: b64(table),
    genderOverrides,
  }),
);

console.log(`pals:     ${palsOut.length}`);
console.log(`passives: ${passives.length}`);
console.log(`breeding: ${filled} species pairs packed, ${genderOverrides.length} gender-specific overrides`);
