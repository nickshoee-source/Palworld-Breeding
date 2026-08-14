#!/usr/bin/env node
// End-to-end checks for the solver against the real 1.0 data. `npm test`.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDatabase } from '../src/data.js';
import { solve, planSteps, planRoots, popcount as popcountOf, MALE, FEMALE } from '../src/solver.js';
import { inheritanceOutcome, randomRollChance } from '../src/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

const db = buildDatabase({
  pals: await read('data/pals.json'),
  passives: await read('data/passives.json'),
  breeding: await read('data/breeding.json'),
});

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const pal = (name) => {
  const i = db.palByName.get(name);
  if (i === undefined) throw new Error(`unknown pal: ${name}`);
  return i;
};
const passive = (name) => {
  const i = db.passiveByName.get(name);
  if (i === undefined) throw new Error(`unknown passive: ${name}`);
  return i;
};

/* ------------------------------------------------------------- the maths */

console.log('\n-- inheritance model');
{
  // Four wanted passives spread over two parents with no junk: the only way to
  // get all four is the 1-in-10 roll that inherits four.
  const clean = inheritanceOutcome(4, 0);
  check(Math.abs(clean.chance - 0.1) < 1e-9, `4 wanted / 0 junk = ${(clean.chance * 100).toFixed(1)}% (expect 10%)`);

  // One wanted passive on an otherwise clean pair is a certainty: any roll takes
  // the whole one-passive pool.
  const single = inheritanceOutcome(1, 0);
  check(Math.abs(single.chance - 1) < 1e-9, `1 wanted / 0 junk = ${(single.chance * 100).toFixed(1)}% (expect 100%)`);

  // Junk on the parents strictly hurts.
  const dirty = inheritanceOutcome(4, 2);
  check(dirty.chance < clean.chance, `junk lowers the odds: ${(dirty.chance * 100).toFixed(2)}% < 10%`);

  const totals = [...clean.junk.values()].reduce((a, b) => a + b, 0);
  check(Math.abs(totals - 1) < 1e-9, 'junk distribution sums to 1');

  const legend = db.passives[passive('Legend')];
  check(!legend.randomInheritable, 'Legend cannot appear from a random roll');
  const artisan = db.passives[passive('Artisan')];
  const rollOdds = randomRollChance(artisan.randomWeight, db.randomPoolWeight);
  check(rollOdds > 0 && rollOdds < 0.05, `Artisan random-roll chance ${(rollOdds * 100).toFixed(2)}% is small but non-zero`);
}

/* ------------------------------------------------------- breeding lookups */

console.log('\n-- breeding table');
{
  check(db.pals[db.childOf(pal('Relaxaurus'), pal('Sparkit'))].name === 'Relaxaurus Lux', 'Relaxaurus x Sparkit = Relaxaurus Lux');
  check(db.pals[db.childOf(pal('Anubis'), pal('Anubis'))].name === 'Anubis', 'Anubis breeds true');
  check(db.stepsBetween(pal('Lamball'), pal('Anubis')) >= 1, 'Lamball can reach Anubis');
  const anubis = db.pals[pal('Anubis')];
  check(anubis.guaranteed.length > 0, `Anubis is born with ${anubis.guaranteed.length} guaranteed passive(s)`);
}

/* ------------------------------------------------------------ the solver */

async function scenario(label, { inventory, targetPal, targetPassives, options }) {
  const started = Date.now();
  const { plans } = await solve({
    db,
    inventory: inventory.map((e) => ({ ...e, pal: pal(e.pal), passives: e.passives.map(passive) })),
    target: { pal: pal(targetPal), passives: targetPassives.map(passive) },
    options,
  });
  const ms = Date.now() - started;
  console.log(`\n${label}  (${ms} ms, ${plans.length} plan(s))`);
  if (plans.length === 0) {
    console.log('  no plan found');
    return { plans, ms };
  }
  const plan = plans[0];
  for (const step of planSteps(plan)) {
    const { a, b, chance, eggsHere, childGender } = step.from;
    const sex = childGender === MALE ? ' male' : childGender === FEMALE ? ' female' : '';
    console.log(
      `  ${db.pals[a.sp].name} x ${db.pals[b.sp].name} -> ${db.pals[step.sp].name}${sex}` +
      `   ${(chance * 100).toFixed(2)}%/egg, ~${eggsHere.toFixed(1)} eggs`,
    );
  }
  console.log(`  total: ${plan.steps} step(s), ~${plan.eggs.toFixed(1)} eggs, ${planRoots(plan).length} starting pals`);
  return { plans, ms };
}

console.log('\n-- solver scenarios');

// Already done: you own the finished article.
{
  const { plans } = await scenario('owned pal already matches', {
    inventory: [{ pal: 'Anubis', passives: ['Legend', 'Musclehead'], gender: '?', count: 1 }],
    targetPal: 'Anubis',
    targetPassives: ['Legend', 'Musclehead'],
    options: { maxSteps: 3, allowWild: false },
  });
  check(plans.length > 0 && plans[0].steps === 0, 'recognised as a zero-step plan');
}

// The classic: merge two passives from two different owned pals into a target.
{
  const { plans, ms } = await scenario('two owned parents -> Anubis with 2 passives', {
    inventory: [
      { pal: 'Anubis', passives: ['Musclehead'], gender: 'M', count: 1 },
      { pal: 'Anubis', passives: ['Ferocious'], gender: 'F', count: 1 },
    ],
    targetPal: 'Anubis',
    targetPassives: ['Musclehead', 'Ferocious'],
    options: { maxSteps: 3, allowWild: false },
  });
  check(plans.length > 0, 'found a plan');
  check(plans[0].steps === 1, 'solved in a single breeding step');
  check(ms < 20000, `finished in ${ms} ms`);
}

// Four passives spread across four owned pals of unrelated species.
{
  const { plans, ms } = await scenario('four passives from four species -> Anubis', {
    inventory: [
      { pal: 'Lamball', passives: ['Musclehead'], gender: 'M', count: 1 },
      { pal: 'Cattiva', passives: ['Ferocious'], gender: 'F', count: 1 },
      { pal: 'Chikipi', passives: ['Burly Body'], gender: 'M', count: 1 },
      { pal: 'Foxparks', passives: ['Swift'], gender: 'F', count: 1 },
    ],
    targetPal: 'Anubis',
    targetPassives: ['Musclehead', 'Ferocious', 'Burly Body', 'Swift'],
    options: { maxSteps: 6, allowWild: true },
  });
  check(plans.length > 0, 'found a plan');
  check(ms < 120000, `finished in ${ms} ms`);
  if (plans.length) {
    const steps = planSteps(plans[0]);
    check(steps.every((s) => s.from.chance > 0), 'every step has a real chance');
    check(plans[0].sp === pal('Anubis'), 'plan ends on the requested species');
    check(popcountOf(plans[0].mask) === 4, 'final Pal carries all four wanted passives');
    check(plans.every((p) => p.steps <= 6), 'no plan exceeds the step budget it was given');
    check(plans.every((p) => planSteps(p).length === p.steps), 'reported step count matches the actual tree');
  }
}

// Legendaries only hatch from two of their own kind, so no other species can
// ever carry a passive into their line. The solver should say so rather than
// inventing a path.
{
  const jetragon = pal('Jetragon');
  const parentPairs = db.parentsOf(jetragon);
  check(
    parentPairs.every(([a, b]) => a === jetragon && b === jetragon),
    'Jetragon only comes from Jetragon x Jetragon',
  );
  const { plans } = await scenario('passives into a legendary from other species', {
    inventory: [
      { pal: 'Jetragon', passives: [], gender: 'M', count: 2 },
      { pal: 'Lamball', passives: ['Musclehead'], gender: 'F', count: 1 },
    ],
    targetPal: 'Jetragon',
    targetPassives: ['Musclehead'],
    options: { maxSteps: 4, allowWild: true },
  });
  check(plans.length === 0, 'correctly reports that it cannot be bred in');
}

// A passive nothing owns and nothing can roll should be impossible to plan for
// unless a wild source carries it.
{
  const { plans } = await scenario('unreachable passive without a source', {
    inventory: [{ pal: 'Lamball', passives: [], gender: 'M', count: 2 }],
    targetPal: 'Lamball',
    targetPassives: ['Legend'],
    options: { maxSteps: 3, allowWild: false },
  });
  check(plans.length === 0, 'correctly reports no plan');
}

// The same request, but allowed to catch: Frostallion is born with Legend.
{
  const { plans } = await scenario('same request, wild catches allowed', {
    inventory: [{ pal: 'Lamball', passives: [], gender: 'M', count: 2 }],
    targetPal: 'Lamball',
    targetPassives: ['Legend'],
    options: { maxSteps: 6, allowWild: true },
  });
  check(plans.length > 0, 'finds a route once a wild source of Legend is allowed');
  if (plans.length) {
    const sources = planRoots(plans[0]).filter((r) => r.origin?.kind === 'wild').map((r) => db.pals[r.sp].name);
    console.log(`  wild pals needed: ${sources.join(', ') || 'none'}`);
    check(planRoots(plans[0]).some((r) => db.pals[r.sp].guaranteed.includes(db.passives[passive('Legend')].id)), 'starts from a Pal born with Legend');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
