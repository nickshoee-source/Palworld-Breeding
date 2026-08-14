// The breeding maths.
//
// Palworld decides a hatched Pal's passive skills in two rolls:
//
//   1. Direct inheritance. The two parents' passive lists are merged into one
//      pool. The game rolls how many passives to take from that pool -- 1, 2, 3
//      or 4, with weights 4:3:2:1 -- then takes that many at random from the
//      pool, without replacement.
//   2. Random addition. It then rolls how many brand-new passives to bolt on --
//      0, 1, 2 or 3, with weights 4:3:2:1 -- filling up to the cap of 4 total.
//
// Both weight tables come straight from the game data (BreedingMechanics in the
// upstream dump), so the odds below are the real ones, not an approximation.

/** Weight of inheriting exactly n passives directly from the parents' pool. */
export const INHERIT_WEIGHTS = [0, 4, 3, 2, 1];
/** Weight of adding exactly n brand-new random passives on top. */
export const RANDOM_WEIGHTS = [4, 3, 2, 1];
/** A Pal can never hold more than four passive skills. */
export const MAX_PASSIVES = 4;

const inheritTotal = INHERIT_WEIGHTS.reduce((a, b) => a + b, 0);
const randomTotal = RANDOM_WEIGHTS.reduce((a, b) => a + b, 0);

const CHOOSE = [];
for (let n = 0; n <= 16; n++) {
  CHOOSE[n] = [];
  for (let k = 0; k <= 16; k++) {
    CHOOSE[n][k] = k < 0 || k > n ? 0 : k === 0 || k === n ? 1 : CHOOSE[n - 1][k - 1] + CHOOSE[n - 1][k];
  }
}
const choose = (n, k) => (n < 0 || k < 0 || k > n ? 0 : CHOOSE[n][k]);

/**
 * Odds that a single egg from a pair of parents carries every wanted passive
 * the parents can supply between them.
 *
 * @param wanted  how many of the target's wanted passives the parents hold
 *                between them (duplicates already merged)
 * @param filler  how many *other* passives the parents hold, which compete for
 *                the same inheritance slots and are what make junk traits hurt
 * @returns {{chance: number, junk: Map<number, number>}} `chance` is the
 *          probability the egg inherits all `wanted` passives; `junk` maps a
 *          number of unwanted passives to its probability *given* that success,
 *          which is what lets the solver charge later steps for dilution.
 */
export function inheritanceOutcome(wanted, filler) {
  const pool = wanted + filler;
  const junk = new Map();
  let chance = 0;

  for (let k = 1; k < INHERIT_WEIGHTS.length; k++) {
    const inheritOdds = INHERIT_WEIGHTS[k] / inheritTotal;
    // Rolling for more passives than the pool holds just takes the whole pool.
    const taken = Math.min(k, pool);
    if (taken < wanted) continue;

    // Of the C(pool, taken) equally likely draws, the ones that scoop up every
    // wanted passive are those that fill the remaining slots from the filler.
    const success = choose(filler, taken - wanted) / choose(pool, taken);
    if (success === 0) continue;

    const inheritedJunk = taken - wanted;
    for (let r = 0; r < RANDOM_WEIGHTS.length; r++) {
      const added = Math.min(r, MAX_PASSIVES - taken);
      const p = inheritOdds * success * (RANDOM_WEIGHTS[r] / randomTotal);
      chance += p;
      const total = inheritedJunk + added;
      junk.set(total, (junk.get(total) ?? 0) + p);
    }
  }

  // Re-weight the junk spread so it reads as "given the egg worked out".
  if (chance > 0) for (const [k, v] of junk) junk.set(k, v / chance);
  return { chance, junk };
}

/** Most likely number of unwanted passives on a successful egg. */
export function likeliestJunk(outcome) {
  let best = 0;
  let bestP = -1;
  for (const [count, p] of outcome.junk) {
    if (p > bestP) {
      bestP = p;
      best = count;
    }
  }
  return best;
}

/**
 * Odds that a random passive roll lands a specific passive. Used to answer
 * "can I ever fish for this trait?" when nothing in the inventory has it.
 *
 * @param weight     the passive's own random-inheritance weight
 * @param poolWeight summed weight of every randomly-inheritable passive
 */
export function randomRollChance(weight, poolWeight) {
  const perSlot = weight / poolWeight;
  let chance = 0;
  for (let r = 1; r < RANDOM_WEIGHTS.length; r++) {
    const odds = RANDOM_WEIGHTS[r] / randomTotal;
    chance += odds * (1 - (1 - perSlot) ** r);
  }
  return chance;
}

/** Expected eggs needed for one success, capped so hopeless odds stay finite. */
export const eggsFor = (chance) => (chance > 0 ? 1 / chance : Infinity);
