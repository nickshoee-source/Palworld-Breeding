// Loads the packed data files and exposes them as a small queryable database.
//
// The single-file build inlines the same three JSON payloads on
// `globalThis.__PALDATA__`, so the app works from a file:// page with no server.

const base64ToTyped = (b64, Type) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Type(bytes.buffer);
};

async function loadPayloads() {
  if (globalThis.__PALDATA__) return globalThis.__PALDATA__;
  const [pals, passives, breeding] = await Promise.all(
    ['pals', 'passives', 'breeding'].map((name) => fetch(`data/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`could not load data/${name}.json (${r.status})`);
      return r.json();
    })),
  );
  return { pals, passives, breeding };
}

export async function loadDatabase() {
  const payloads = await loadPayloads();
  return buildDatabase(payloads);
}

export function buildDatabase({ pals: palsFile, passives: passivesFile, breeding: breedingFile }) {
  const pals = palsFile.pals;
  const passives = passivesFile.passives;
  const n = breedingFile.count;

  const pairs = base64ToTyped(breedingFile.pairs, Uint16Array);

  const palByName = new Map(pals.map((p, i) => [p.name, i]));
  const palById = new Map(pals.map((p, i) => [p.id, i]));
  const passiveByName = new Map(passives.map((p, i) => [p.name, i]));
  const passiveById = new Map(passives.map((p, i) => [p.id, i]));

  // Offset of the unordered pair (i <= j) inside the flattened upper triangle.
  const offset = (i, j) => (i * (2 * n - i + 1)) / 2 + (j - i);

  /** The Pal that hatches when species `a` and species `b` are bred. */
  const childOf = (a, b) => (a <= b ? pairs[offset(a, b)] : pairs[offset(b, a)]);

  const UNREACHABLE = 255;
  const distanceCache = new Map();

  /**
   * Fewest breeding steps needed to turn each species into `to`, assuming any
   * partner can be obtained. Walked backwards from the target one generation at
   * a time; the result is cached per target because the solver asks for it on
   * every search and the whole sweep is only a few hundred thousand lookups.
   *
   * @returns {Uint8Array} indexed by species, 255 when the target is out of reach
   */
  const distancesTo = (to, maxDepth = 6) => {
    const cacheKey = `${to}:${maxDepth}`;
    const cached = distanceCache.get(cacheKey);
    if (cached) return cached;

    const dist = new Uint8Array(n).fill(UNREACHABLE);
    dist[to] = 0;
    for (let level = 1; level <= maxDepth; level++) {
      for (let s = 0; s < n; s++) {
        if (dist[s] !== UNREACHABLE) continue;
        for (let partner = 0; partner < n; partner++) {
          if (dist[childOf(s, partner)] === level - 1) {
            dist[s] = level;
            break;
          }
        }
      }
    }
    distanceCache.set(cacheKey, dist);
    return dist;
  };

  /** Fewest breeding steps to get from species `from` to species `to`, or null. */
  const stepsBetween = (from, to) => {
    const v = distancesTo(to)[from];
    return v === UNREACHABLE ? null : v;
  };

  // Katress x Wixen is the one pair whose result depends on which parent is
  // female. Keyed by "a|b" with a <= b.
  const genderSplits = new Map();
  for (const o of breedingFile.genderOverrides) {
    const [a, b] = o.parents;
    const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
    if (!genderSplits.has(key)) genderSplits.set(key, []);
    genderSplits.get(key).push(o);
  }

  // Every parent pair that produces a given child, built once on demand.
  let parentsCache = null;
  const parentsOf = (child) => {
    if (!parentsCache) {
      parentsCache = Array.from({ length: n }, () => []);
      for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
          parentsCache[pairs[offset(i, j)]].push([i, j]);
        }
      }
    }
    return parentsCache[child];
  };

  // Which Pals are born already holding a given passive. This is how a trait
  // that cannot be randomly inherited enters a breeding line at all.
  const sourcesOfPassive = new Map();
  for (const [index, pal] of pals.entries()) {
    for (const id of pal.guaranteed) {
      const p = passiveById.get(id);
      if (p === undefined) continue;
      if (!sourcesOfPassive.has(p)) sourcesOfPassive.set(p, []);
      sourcesOfPassive.get(p).push(index);
    }
  }

  const randomPoolWeight = passives
    .filter((p) => p.randomInheritable)
    .reduce((sum, p) => sum + p.randomWeight, 0);

  return {
    version: breedingFile.version,
    palCount: n,
    pals,
    passives,
    workTypes: palsFile.workTypes,
    palByName,
    palById,
    passiveByName,
    passiveById,
    childOf,
    parentsOf,
    stepsBetween,
    distancesTo,
    UNREACHABLE,
    genderSplits,
    sourcesOfPassive,
    randomPoolWeight,
  };
}
