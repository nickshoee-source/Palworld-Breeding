// Breeding path solver.
//
// The search grows a pool of "candidates" -- Pals you either already have, can
// catch, or could hatch along the way. Every round it breeds every new candidate
// against everything found so far, keeps the children that are worth keeping,
// and repeats. A candidate is worth keeping when nothing already found reaches
// the same species carrying the same wanted passives with less junk, fewer
// steps and fewer eggs.
//
// Only the passives you asked for are tracked by name. Everything else on a Pal
// is counted but not identified, because for planning purposes an unwanted trait
// only matters as one more thing competing for an inheritance slot.

import { inheritanceOutcome, likeliestJunk, eggsFor, MAX_PASSIVES } from './model.js';

const popcount = (x) => {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
};

const MALE = 1;
const FEMALE = 2;
const EITHER = 3; // gender not yet pinned down

const genderChance = (pal, gender) => (gender === MALE ? pal.maleChance : gender === FEMALE ? 1 - pal.maleChance : 1);

// Two candidates can only be bred if they can be opposite sexes.
const compatible = (a, b) => (a.gender | b.gender) === EITHER || a.gender === EITHER || b.gender === EITHER;

const disjoint = (a, b) => (a.usedLo & b.usedLo) === 0 && (a.usedHi & b.usedHi) === 0;

const KEY = (sp, mask, gender) => sp * 64 + mask * 4 + gender;

/**
 * @param {object}   db          database from data.js
 * @param {object[]} inventory   `{ pal, passives:number[], gender:'M'|'F'|'?', count }`
 * @param {object}   target      `{ pal:number, passives:number[] }`
 * @param {object}   options     `{ maxSteps, allowWild, maxJunk, frontierCap, objective }`
 * @param {function} onProgress  called with `{ round, candidates, results }`
 */
export async function solve({ db, inventory, target, options = {}, onProgress = () => {} }) {
  const {
    maxSteps = 4,
    allowWild = true,
    maxJunk = MAX_PASSIVES,
    frontierCap = 2000,
    objective = 'balanced',
  } = options;

  // How many steps each species still needs to become the target. Anything
  // further away than the rounds remaining is a dead end and gets dropped.
  const distance = db.distancesTo(target.pal, maxSteps);

  const wanted = target.passives.slice(0, MAX_PASSIVES);
  const wantedIndex = new Map(wanted.map((p, i) => [p, i]));
  const requiredMask = (1 << wanted.length) - 1;
  const maskOf = (passives) => passives.reduce((m, p) => (wantedIndex.has(p) ? m | (1 << wantedIndex.get(p)) : m), 0);

  /* ---------------------------------------------------------- root pals */

  const roots = [];
  let exclusiveBits = 0;

  inventory.forEach((entry, i) => {
    const mask = maskOf(entry.passives);
    const filler = entry.passives.filter((p) => !wantedIndex.has(p)).length;
    // A Pal you own exactly one of cannot appear twice in the same tree; one you
    // own several of can. That is tracked as a bit only for the singletons.
    let lo = 0;
    let hi = 0;
    if ((entry.count ?? 1) < 2 && exclusiveBits < 64) {
      const bit = exclusiveBits++;
      if (bit < 32) lo = 1 << bit;
      else hi = 1 << (bit - 32);
    }
    roots.push({
      sp: entry.pal,
      mask,
      filler,
      gender: entry.gender === 'M' ? MALE : entry.gender === 'F' ? FEMALE : EITHER,
      eggs: 0,
      steps: 0,
      captures: 0,
      cost: 0,
      usedLo: lo,
      usedHi: hi,
      from: null,
      origin: { kind: 'owned', entry: i },
    });
  });

  // Catching a Pal is work too, and catching a rare one is a lot of work. This
  // keeps the solver from casually routing a plan through a legendary when a
  // field Pal does the same job.
  const captureCost = (pal) => 1 + (pal.rarity ?? 1) / 2;

  if (allowWild) {
    for (let sp = 0; sp < db.palCount; sp++) {
      const pal = db.pals[sp];
      // A wild catch arrives with whatever passives its species always has.
      const guaranteed = pal.guaranteed.map((id) => db.passiveById.get(id)).filter((p) => p !== undefined);
      roots.push({
        sp,
        mask: maskOf(guaranteed),
        filler: guaranteed.filter((p) => !wantedIndex.has(p)).length,
        gender: EITHER,
        eggs: 0,
        steps: 0,
        captures: 1,
        cost: captureCost(pal),
        usedLo: 0,
        usedHi: 0,
        from: null,
        origin: { kind: 'wild' },
      });
    }
  }

  /* ------------------------------------------------------- frontier state */

  // For each (species, wanted-passives, sex) the best few candidates, kept as a
  // Pareto front over junk / eggs / steps / captures.
  const best = new Map();
  const results = [];

  const dominates = (a, b) =>
    a.filler <= b.filler && a.cost <= b.cost + 1e-9 && a.steps <= b.steps &&
    (a.filler < b.filler || a.cost < b.cost - 1e-9 || a.steps < b.steps);

  function offer(candidate) {
    if (candidate.filler > maxJunk) return false;
    if (!Number.isFinite(candidate.eggs)) return false;
    const key = KEY(candidate.sp, candidate.mask, candidate.gender);
    const front = best.get(key);
    if (!front) {
      best.set(key, [candidate]);
      return true;
    }
    for (const existing of front) if (dominates(existing, candidate)) return false;
    const kept = front.filter((existing) => !dominates(candidate, existing));
    kept.push(candidate);
    // Guard against a single key hoarding near-identical entries.
    kept.sort((a, b) => a.steps - b.steps || a.cost - b.cost);
    best.set(key, kept.slice(0, 4));
    return true;
  }

  // The Pal you actually wanted does not have to be a particular sex, so the
  // final step is costed without the gender penalty that every earlier step pays.
  const recordResult = (candidate) => results.push(candidate);

  let frontier = [];
  let delta = [];
  for (const root of roots) {
    if (offer(root)) delta.push(root);
    if (root.sp === target.pal && (root.mask & requiredMask) === requiredMask) results.push(root);
  }
  frontier = delta.slice();

  /* ------------------------------------------------------------ the search */

  const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Pals carrying none of the wanted passives are interchangeable: the only
  // thing they contribute to a pairing is their species. So instead of pairing
  // against every one of them, pair against the cheapest one per species and
  // sex. That collapses the great majority of the search space -- without it,
  // steering a lineage towards the right species dominates the run time.
  const partnersFrom = (pool) => {
    const carriers = [];
    const plain = new Map();
    for (const c of pool) {
      if (c.mask !== 0) {
        carriers.push(c);
        continue;
      }
      const key = KEY(c.sp, 0, c.gender);
      const held = plain.get(key);
      if (!held || c.filler < held.filler || (c.filler === held.filler && c.cost < held.cost)) plain.set(key, c);
    }
    return carriers.concat([...plain.values()]);
  };

  for (let round = 1; round <= maxSteps; round++) {
    const produced = [];
    let examined = 0;
    const partners = partnersFrom(frontier);

    for (const a of delta) {
      for (const b of partners) {
        examined++;
        if (!compatible(a, b) || !disjoint(a, b)) continue;

        const mask = a.mask | b.mask;
        // Nothing is gained by a pairing that collects no more wanted passives
        // than a parent already had, unless it moves us to a different species.
        const childSp = db.childOf(a.sp, b.sp);
        if (mask === a.mask && mask === b.mask && childSp === a.sp && childSp === b.sp) continue;

        // A step is one breeding, so a balanced tree spends several per round.
        // Count the real total, and drop any child that could not reach the
        // target within the budget even by the shortest remaining route.
        const steps = a.steps + b.steps + 1;
        if (steps + distance[childSp] > maxSteps) continue;

        const pool = Math.min(a.filler + b.filler, 12);
        const outcome = inheritanceOutcome(popcount(mask), pool);
        if (outcome.chance === 0) continue;
        const junk = likeliestJunk(outcome);
        const eggsBase = a.eggs + b.eggs;
        const captures = a.captures + b.captures;
        const costBase = a.cost + b.cost;

        if (childSp === target.pal && (mask & requiredMask) === requiredMask) {
          const eggsHere = eggsFor(outcome.chance);
          recordResult({
            sp: childSp, mask, filler: junk, gender: EITHER,
            eggs: eggsBase + eggsHere, steps, captures, cost: costBase + eggsHere,
            usedLo: a.usedLo | b.usedLo, usedHi: a.usedHi | b.usedHi,
            from: { a, b, chance: outcome.chance, eggsHere, childGender: EITHER },
            origin: null,
          });
        }

        if (round === maxSteps) continue; // no point storing parents we can never use

        for (const gender of [MALE, FEMALE]) {
          const chance = outcome.chance * genderChance(db.pals[childSp], gender);
          const eggsHere = eggsFor(chance);
          const candidate = {
            sp: childSp, mask, filler: junk, gender,
            eggs: eggsBase + eggsHere, steps, captures, cost: costBase + eggsHere,
            usedLo: a.usedLo | b.usedLo, usedHi: a.usedHi | b.usedHi,
            from: { a, b, chance, eggsHere, childGender: gender },
            origin: null,
          };
          if (offer(candidate)) produced.push(candidate);
        }
      }
      if (examined > 400000) {
        examined = 0;
        await yieldToUi();
      }
    }

    // Keep the frontier bounded: prefer candidates carrying more of the wanted
    // passives, then the cheapest ones.
    produced.sort((x, y) => popcount(y.mask) - popcount(x.mask) || x.steps - y.steps || x.cost - y.cost);
    delta = produced.slice(0, frontierCap);
    frontier = frontier.concat(delta);
    onProgress({ round, candidates: frontier.length, results: results.length });
    await yieldToUi();
    if (delta.length === 0) break;
  }

  /* ------------------------------------------------------------- ranking */

  // Every extra step costs real time even when its odds are good: another pair
  // to set up, another cake run, another trip to the ranch. Charging a few eggs
  // per step is what stops "fastest" from meaning a ten-step chain of near-certain
  // hatches, and stops "fewest steps" from meaning a 1%-per-egg grind.
  const STEP_OVERHEAD = 3;
  const RANKS = {
    steps: (a, b) => a.steps - b.steps || a.cost - b.cost,
    eggs: (a, b) => a.eggs - b.eggs || a.steps - b.steps,
    balanced: (a, b) => a.cost + a.steps * STEP_OVERHEAD - (b.cost + b.steps * STEP_OVERHEAD) || a.steps - b.steps,
  };
  const rank = RANKS[objective] ?? RANKS.balanced;

  // Distinct plans only. Identical trees are obviously the same plan, but so is
  // a tree that swaps one interchangeable partner in the last step: showing ten
  // routes whose first four steps match is noise, not choice. A plan therefore
  // has to differ from every plan already kept in a decent share of its steps.
  const OVERLAP_LIMIT = 0.6;
  const seen = new Set();
  const keptSteps = [];
  const unique = [];

  for (const r of results.sort(rank)) {
    const sig = signature(r);
    if (seen.has(sig)) continue;
    seen.add(sig);

    const mine = new Set(planSteps(r).map(stepSignature));
    const tooSimilar = keptSteps.some((theirs) => {
      let shared = 0;
      for (const s of mine) if (theirs.has(s)) shared++;
      return shared / Math.max(mine.size, theirs.size, 1) > OVERLAP_LIMIT;
    });
    if (tooSimilar) continue;

    keptSteps.push(mine);
    unique.push(r);
    if (unique.length >= 24) break;
  }

  const plans = unique.slice(0, 6);
  // Always surface the extremes, so the trade-off between a short plan and a
  // cheap one is visible instead of hidden behind whichever sort is active.
  for (const alternative of [[...unique].sort(RANKS.steps)[0], [...unique].sort(RANKS.eggs)[0]]) {
    if (alternative && !plans.includes(alternative)) plans.push(alternative);
  }

  return { plans, wanted, requiredMask, roots: roots.length, objective };
}

/** Identifies one breeding step, regardless of which parent is named first. */
function stepSignature(node) {
  const { a, b } = node.from;
  const [x, y] = a.sp <= b.sp ? [a.sp, b.sp] : [b.sp, a.sp];
  return `${x}+${y}=${node.sp}:${node.mask}`;
}

function signature(candidate) {
  if (!candidate.from) return `own:${candidate.sp}:${candidate.mask}:${candidate.origin?.entry ?? 'w'}`;
  const { a, b } = candidate.from;
  const [x, y] = [signature(a), signature(b)].sort();
  return `(${x}+${y})->${candidate.sp}:${candidate.mask}`;
}

/** Flattens a plan into an ordered list of breeding steps, parents first. */
export function planSteps(plan) {
  const steps = [];
  const walk = (node) => {
    if (!node.from) return;
    walk(node.from.a);
    walk(node.from.b);
    steps.push(node);
  };
  walk(plan);
  return steps;
}

/** Every owned or wild Pal a plan starts from. */
export function planRoots(plan) {
  const found = [];
  const walk = (node) => {
    if (!node.from) {
      found.push(node);
      return;
    }
    walk(node.from.a);
    walk(node.from.b);
  };
  walk(plan);
  return found;
}

export { MALE, FEMALE, EITHER, popcount };
