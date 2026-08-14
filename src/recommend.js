// Which four passives a Pal actually wants, for the job you have in mind.
//
// Nothing here is a hand-written tier list. Every passive's effects were parsed
// out of its in-game description at build time, and a role is just a set of
// weights saying how much one point of each effect is worth for that job. A
// passive's score is the dot product of the two. That means the ranking explains
// itself -- each recommendation can show the exact numbers behind it -- and it
// stays honest when a Pal update changes a value.

/** Flat effects are worth a fixed number of points rather than points-per-percent. */
const FLAT = new Set([
  'immune:Flinch', 'immune:Knockback', 'immune:Explosion', 'immune:Burn', 'immune:Poison',
  'mountedJump', 'worksAtNight', 'sleepsInDay', 'pacifist', 'farmingSuitability', 'worldTreeHarvest',
]);

export const WORK_TASKS = [
  'Kindling', 'Watering', 'Planting', 'Electricity', 'Handiwork', 'Gathering',
  'Lumbering', 'Mining', 'Medicine', 'Cooling', 'Transporting', 'Farming',
];

export const ROLES = [
  {
    id: 'combat',
    label: 'Combat',
    blurb: 'A Pal you send out to fight, in your active party.',
    weights: {
      attack: 1, defense: 0.6, maxHp: 0.5, lifeSteal: 1.5, cooldown: 0.8,
      palRegen: 0.08, maxStamina: 0.1, moveSpeed: 0.15,
      hungerSaved: 0.05, sanSaved: 0.05,
      'immune:Flinch': 6, 'immune:Knockback': 4, 'immune:Explosion': 3,
      'immune:Burn': 1, 'immune:Poison': 1,
      pacifist: -100,
      elementAttack: 0.9, elementResist: 0.15,
    },
  },
  {
    id: 'mount',
    label: 'Mount / overworld',
    blurb: 'The Pal you ride or fly around on between objectives.',
    weights: {
      moveSpeed: 1, maxStamina: 0.5, hungerSaved: 0.4, mountedJump: 8,
      waterMoveSpeed: 0.2, attack: 0.1, defense: 0.1, sanSaved: 0.1,
      'immune:Flinch': 2, 'immune:Knockback': 2,
    },
  },
  {
    id: 'base',
    label: 'Base worker',
    blurb: 'A Pal assigned to your base to do a specific job.',
    weights: {
      workSpeed: 1, sanSaved: 0.7, hungerSaved: 0.5, worksAtNight: 12, sleepsInDay: -8,
      maxHp: 0.05, defense: 0.05, farmingSuitability: 0,
    },
  },
  {
    id: 'breeding',
    label: 'Breeding farm',
    blurb: 'A Pal parked in a Breeding Farm to speed up your other projects.',
    weights: {
      breedSpeed: 1, eggSpeed: 0.8, incubationSpeed: 0.8,
      hungerSaved: 0.3, sanSaved: 0.3, workSpeed: 0.1,
    },
  },
  {
    id: 'support',
    label: 'Player support',
    blurb: 'A Pal kept in the party for the buffs it gives you, not for its own damage.',
    weights: {
      playerAttack: 1, playerDefense: 1, playerWorkSpeed: 1, playerMining: 1, playerLogging: 1,
      playerRegen: 0.6, playerStamina: 0.6, playerReload: 0.6,
      dropRate: 0.3, itemValue: 0.2, worldTreeHarvest: 5,
      attack: 0.2, defense: 0.2,
    },
  },
];

const ELEMENTS = ['Neutral', 'Fire', 'Water', 'Grass', 'Electric', 'Ice', 'Ground', 'Dark', 'Dragon'];

/**
 * Scores one passive for one role.
 *
 * @param element  the Pal's element, so an element booster is only credited when
 *                 it matches. Pass null to leave element boosters out entirely.
 * @returns `{ score, contributions }` where each contribution explains a slice
 *          of the total in plain terms.
 */
export function scorePassive(passive, role, { element = null, workTask = null } = {}) {
  const weights = { ...role.weights };

  // Farming is the one job a passive can add work suitability to.
  if (role.id === 'base') weights.farmingSuitability = workTask === 'Farming' ? 25 : 0;

  let score = 0;
  const contributions = [];

  for (const [key, value] of Object.entries(passive.effects)) {
    let weight;
    let label = key;

    if (key.startsWith('elemAtk:')) {
      const of = key.slice(8);
      if (!element) continue;
      weight = of === element ? weights.elementAttack ?? 0 : 0;
      label = `${of} damage`;
    } else if (key.startsWith('elemRes:')) {
      weight = weights.elementResist ?? 0;
      label = `${key.slice(8)} resistance`;
    } else {
      weight = weights[key] ?? 0;
    }

    if (!weight) continue;
    const points = weight * value;
    score += points;
    contributions.push({ key, label, value, points, flat: FLAT.has(key) });
  }

  contributions.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, contributions };
}

/**
 * How a passive can get onto a Pal.
 *
 * Any passive is inherited from a parent that already has it. What varies is how
 * it enters your line in the first place: the breeding roll can invent some
 * passives out of nothing, some species are born holding one, and the rest have
 * to be caught on a wild Pal or applied with a surgery item.
 */
export function obtainability(db, passiveIndex) {
  const passive = db.passives[passiveIndex];
  const sources = (db.sourcesOfPassive.get(passiveIndex) ?? []).map((i) => db.pals[i].name);
  return {
    /** The random-addition roll during breeding can produce this from nothing. */
    randomInheritable: passive.randomInheritable,
    /** Rollable, but on the rare table -- twenty times less likely than usual. */
    rare: passive.randomInheritable && passive.randomWeight < 100,
    /** Species born holding it, which is the reliable way to seed a line. */
    sources,
    surgeryItem: passive.surgeryItem,
    /** True when the passive can appear without you already owning one. */
    seedable: passive.randomInheritable || sources.length > 0,
  };
}

/**
 * Ranks every passive for a role and picks a four-slot loadout.
 *
 * @param options `{ role, element, workTask, breedableOnly }`
 */
export function recommendPassives(db, { role, element = null, workTask = null, breedableOnly = false }) {
  const scored = db.passives
    .map((passive, index) => {
      const { score, contributions } = scorePassive(passive, role, { element, workTask });
      return { index, passive, score, contributions, obtain: obtainability(db, index) };
    })
    .filter((entry) => entry.contributions.length > 0);

  const positive = scored.filter((e) => e.score > 0).sort((a, b) => b.score - a.score);
  const negative = scored.filter((e) => e.score < 0).sort((a, b) => a.score - b.score);

  const eligible = breedableOnly ? positive.filter((e) => e.obtain.seedable) : positive;

  // A Pal has exactly four passive slots, so the recommendation is the best four.
  const loadout = eligible.slice(0, 4);
  const alternatives = eligible.slice(4, 12);

  const notes = [];
  if (role.id === 'combat' && !element) {
    notes.push(
      'Pick your Pal’s element to have the element boosters ranked too — a matching booster ' +
      'is usually worth a slot on a damage dealer.',
    );
  }
  if (role.id === 'base' && workTask === 'Farming') {
    notes.push('Ranch Master and Farmhand raise Farming suitability outright, which is why they outrank raw work speed here.');
  }
  if (role.id === 'base') {
    notes.push('Work speed is only half the job: a Pal whose SAN bottoms out stops working entirely, so SAN-preserving passives are scored alongside it.');
  }
  const hardToSeed = loadout.filter((e) => !e.obtain.seedable);
  if (hardToSeed.length) {
    const withSurgery = hardToSeed.filter((e) => e.obtain.surgeryItem).map((e) => e.passive.name);
    notes.push(
      `${hardToSeed.map((e) => e.passive.name).join(', ')} never appears from a breeding roll and no species is born ` +
      'with it, so a line can only inherit it from a parent that already has it — a wild Pal you catch holding it' +
      (withSurgery.length ? `, or a passive-skill surgery (${withSurgery.join(', ')}).` : '.'),
    );
  }

  return { loadout, alternatives, avoid: negative.slice(0, 6), notes, role, element, workTask };
}

/** The Pals with the highest suitability for a base job, best first. */
export function bestPalsForTask(db, task, limit = 12) {
  return db.pals
    .map((pal, index) => ({ index, pal, level: pal.work[task] ?? 0 }))
    .filter((e) => e.level > 0)
    .sort((a, b) => b.level - a.level || b.pal.craftSpeed - a.pal.craftSpeed || a.pal.name.localeCompare(b.pal.name))
    .slice(0, limit);
}

export { ELEMENTS };
