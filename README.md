# Palworld Breeding Optimiser

A breeding planner for Palworld 1.0. Tell it which Pals you already own and what
you want to end up with, and it works out the route: which pairs to breed, in
what order, what sex each child needs to be, and roughly how many eggs each step
will take. It also tells you which four passives a Pal should actually have for
the job you have in mind.

Three tools in one page:

| Tab | What it does |
| --- | --- |
| **Breeding planner** | Your Pals + the Pal you want → ranked breeding routes, step by step |
| **Best passives** | A Pal + a role (combat, mount, base job, breeding farm, player support) → the best passives for *that* Pal, scored from the game's own numbers |
| **Combo lookup** | What two Pals make, and every pair that produces a given Pal |

## Running it

No build step and no server needed for the single-file version:

```sh
npm install          # only needed for the build and test scripts
npm run build        # writes dist/palbreeder.html
```

`dist/palbreeder.html` is completely self-contained — open it straight from
disk. To run the multi-file version instead, serve the repo root over HTTP
(`npm run serve`, then <http://localhost:8765>); ES modules and `fetch` need a
real origin, so opening `index.html` from disk will not work.

## The data

Everything comes from the game's own tables, by way of the
[palcalc](https://github.com/tylercamp/palcalc) data dumps (MIT) for Pals,
passives and breeding, and [Pal Editor](https://github.com/KrisCris/Palworld-Pal-Editor)
(MIT) for elements. Both are generated directly from Palworld's data assets and
key on the same internal names:

- **299 Pals** with stats, elements, work suitability, gender odds and innate passives
- **115 passive skills** with their real effect values
- **All 44,850 breeding pairs**, plus the one pair whose result depends on which
  parent is female (Katress × Wixen)

`npm run data` refetches the upstream dumps into `vendor/` (gitignored) and
regenerates `data/`. The 8.9 MB raw breeding table is packed into a 239 KB
matrix: every unordered species pair has exactly one entry, so the pair
`(i ≤ j)` lives at a computed offset holding a `uint16` child index — no parent
names stored per row. `npm run verify` round-trips all 44,849 rows back against
the raw dump.

## How the planner decides

Palworld picks a hatchling's passives in two rolls, and the weights below are
the game's, not estimates:

1. **Direct inheritance.** Both parents' passives go into one pool. The game
   rolls how many to take — 1, 2, 3 or 4, weighted 4:3:2:1 — and takes that many
   at random from the pool.
2. **Random addition.** It then rolls 0, 1, 2 or 3 brand-new passives, weighted
   4:3:2:1, filling up to the cap of four.

Two things follow, and they drive most of the advice the app gives:

- **Junk hurts, a lot.** Unwanted passives sit in the same pool and compete for
  the same slots. Four wanted passives on otherwise clean parents come through
  on 10% of eggs; add two junk traits and it drops to 0.67%.
- **Some passives can't be conjured.** 30 of the 115 — Legend, Lucky and the
  whole element-emperor line among them — never appear from the random roll. If
  no Pal in your line already has one, breeding will never produce it. The app
  checks this before searching and tells you which species are born holding it.

The solver grows a pool of candidate Pals — ones you own, ones you're willing to
catch, and ones you could hatch along the way — and repeatedly breeds everything
new against everything found so far, keeping a child only when nothing already
found reaches the same species with the same wanted passives more cheaply. Only
the passives you asked for are tracked by name; everything else is counted but
not identified, because an unwanted trait only matters as one more competitor
for a slot.

Costs are in expected eggs, derived from the odds above and each species' gender
split. Catching is charged too, scaled by rarity, so a plan won't casually route
through a legendary when a field Pal does the same job. Ranking defaults to
"quickest overall", which charges a few eggs per step — otherwise "fewest steps"
happily returns a two-step plan at 1% per egg, and "fewest eggs" returns a
ten-step chain of near-certain hatches. Both are available as explicit sort
options, and every route shows both numbers.

## How the passive recommender decides

Pick a Pal and the answer is about that Pal, not its role in general. Its
elements decide which damage boosters count; the passives it is born with are
excluded and reduce the slots left to breed for (Frostallion arrives with Legend
and Ice Emperor, so only two slots are open); attack and defense weights scale
with its actual stats, because a percentage buff pays out in proportion to the
stat it multiplies; the base-job list is limited to jobs it can really be
assigned to; and a nocturnal Pal scores Insomnia at nothing because it already
works at night.

Underneath that, there is no hand-written tier list. Each passive's effects were parsed out of its
in-game description at build time (`Attack +20%` → `attack: 20`), and a role is a
set of weights saying what one point of each effect is worth for that job. A
passive's score is the dot product, so every recommendation can show the numbers
behind it, and a game update that changes a value changes the ranking.

The parser is strict: any description line it does not recognise fails the data
build rather than being silently dropped, so new wording in a patch gets noticed.

## Known limits

- **IVs are not modelled.** The planner optimises species and passives only.
- **Junk passives on intermediates are estimated**, not tracked individually —
  the solver carries the most likely count forward rather than enumerating which
  specific unwanted traits a child ends up with.
- **Wild Pals are assumed to be caught clean.** A wild catch is treated as having
  only the passives its species is always born with.

## Layout

```
index.html            the page
assets/app.css        styles
src/model.js          inheritance probability maths
src/data.js           loads and unpacks data/, derives breeding distances
src/solver.js         the breeding path search
src/recommend.js      passive scoring and role profiles
src/app.js            UI wiring
data/                 packed, committed game data
tools/                fetch, build, verify, test, bundle
```

## Tests

```sh
npm run verify   # packed data round-trips against the raw upstream dump
npm test         # inheritance maths, breeding lookups, solver scenarios
npm run smoke    # drives the real page in Chromium (needs `npm run serve`)
```
