// UI wiring. Everything that decides anything lives in model.js, solver.js and
// recommend.js; this file only collects input, calls them, and renders.

import { loadDatabase } from './data.js';
import { solve, planSteps, planRoots, MALE, FEMALE } from './solver.js';
import { randomRollChance } from './model.js';
import { ROLES, WORK_TASKS, ELEMENTS, recommendPassives, obtainability, bestPalsForTask } from './recommend.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) node.append(child);
  return node;
};
const pct = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
const round = (x) => (x >= 100 ? Math.round(x) : x.toFixed(1));

const STORAGE_KEY = 'palworld-breeding-optimiser.inventory.v1';

const db = await loadDatabase();

/* ------------------------------------------------------------------ state */

const state = {
  inventory: load(),
  draftPassives: [],
  targetPassives: [],
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    // Names are stored rather than indices so a data update cannot silently
    // repoint someone's saved Pals at the wrong species.
    return saved
      .map((e) => ({
        pal: db.palByName.get(e.pal),
        passives: (e.passives ?? []).map((p) => db.passiveByName.get(p)).filter((p) => p !== undefined),
        gender: e.gender ?? '?',
        count: e.count ?? 1,
      }))
      .filter((e) => e.pal !== undefined);
  } catch {
    return [];
  }
}

function save() {
  const plain = state.inventory.map((e) => ({
    pal: db.pals[e.pal].name,
    passives: e.passives.map((p) => db.passives[p].name),
    gender: e.gender,
    count: e.count,
  }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
  } catch {
    // Private browsing or a full quota: the list still works for this session.
  }
}

/* -------------------------------------------------------------- datalists */

for (const pal of db.pals) $('pal-list').append(el('option', { value: pal.name }));
for (const passive of [...db.passives].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))) {
  $('passive-list').append(el('option', { value: passive.name, label: passive.description.split('\n')[0] }));
}
$('footnote').textContent =
  `Pal, passive and breeding data extracted from Palworld ${db.version}. ` +
  'Odds come from the game’s own inheritance weights.';

/* ------------------------------------------------------------------- tabs */

const TABS = [['tab-plan', 'view-plan'], ['tab-passives', 'view-passives'], ['tab-combos', 'view-combos']];
for (const [tabId, viewId] of TABS) {
  $(tabId).addEventListener('click', () => {
    for (const [t, v] of TABS) {
      $(t).setAttribute('aria-selected', String(t === tabId));
      $(v).hidden = v !== viewId;
    }
  });
}

/* -------------------------------------------------------- passive pickers */

/** A chip list bound to an array of passive indices, capped at four. */
function passivePicker({ input, container, list, onChange = () => {} }) {
  const render = () => {
    container.replaceChildren(
      ...list().map((index) => {
        const chip = el('span', { className: 'tag want' }, `${db.passives[index].name} `);
        chip.append(el('button', {
          className: 'btn small ghost',
          style: 'padding:0 2px;font-size:12px;line-height:1',
          textContent: '×',
          title: 'Remove',
          onclick: () => {
            const arr = list();
            arr.splice(arr.indexOf(index), 1);
            render();
            onChange();
          },
        }));
        return chip;
      }),
    );
  };

  const add = () => {
    const index = db.passiveByName.get(input.value.trim());
    const arr = list();
    if (index === undefined || arr.includes(index) || arr.length >= 4) {
      if (arr.length >= 4) input.setCustomValidity('');
      input.value = '';
      return;
    }
    arr.push(index);
    input.value = '';
    render();
    onChange();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  // Picking from the datalist fires change, not Enter.
  input.addEventListener('change', add);
  render();
  return render;
}

const renderDraftPassives = passivePicker({
  input: $('own-passive'),
  container: $('own-passive-tags'),
  list: () => state.draftPassives,
});

const renderTargetPassives = passivePicker({
  input: $('target-passive'),
  container: $('target-passive-tags'),
  list: () => state.targetPassives,
  onChange: () => renderTargetAdvice(),
});

/* -------------------------------------------------------------- inventory */

function renderInventory() {
  const host = $('inventory');
  if (state.inventory.length === 0) {
    host.replaceChildren(el('p', { className: 'empty' }, 'Nothing added yet. Your list is saved in this browser.'));
    return;
  }

  const rows = state.inventory.map((entry, i) => {
    const pal = db.pals[entry.pal];
    const sex = entry.gender === 'M' ? 'Male' : entry.gender === 'F' ? 'Female' : 'Either';
    const tags = el('div', { className: 'tags' },
      entry.passives.length
        ? entry.passives.map((p) => el('span', { className: 'tag' }, db.passives[p].name))
        : [el('span', { className: 'empty', style: 'padding:0' }, 'no passives')]);

    return el('tr', {}, [
      el('td', {}, [el('div', { className: 'pal' }, pal.name), tags]),
      el('td', { className: 'num' }, `${sex}${entry.count > 1 ? ` ×${entry.count}` : ''}`),
      el('td', { className: 'num' }, el('button', {
        className: 'btn small ghost',
        textContent: 'Remove',
        onclick: () => {
          state.inventory.splice(i, 1);
          save();
          renderInventory();
          renderTargetAdvice();
        },
      })),
    ]);
  });

  host.replaceChildren(el('table', {}, [
    el('thead', {}, el('tr', {}, [el('th', {}, 'Pal'), el('th', { className: 'num' }, 'Sex'), el('th', {})])),
    el('tbody', {}, rows),
  ]));
}

$('own-add').addEventListener('click', () => {
  const pal = db.palByName.get($('own-pal').value.trim());
  if (pal === undefined) {
    $('own-pal').focus();
    return;
  }
  state.inventory.push({
    pal,
    passives: [...state.draftPassives],
    gender: $('own-gender').value,
    count: Math.max(1, Number($('own-count').value) || 1),
  });
  state.draftPassives = [];
  renderDraftPassives();
  $('own-pal').value = '';
  $('own-count').value = '1';
  save();
  renderInventory();
  renderTargetAdvice();
});

$('inv-clear').addEventListener('click', () => {
  if (state.inventory.length && !confirm('Remove every Pal from your list?')) return;
  state.inventory = [];
  save();
  renderInventory();
  renderTargetAdvice();
});

$('inv-export').addEventListener('click', () => {
  const text = localStorage.getItem(STORAGE_KEY) ?? '[]';
  navigator.clipboard?.writeText(text).then(
    () => alert('Your Pal list has been copied to the clipboard.'),
    () => prompt('Copy your Pal list:', text),
  );
});

$('inv-import').addEventListener('click', () => {
  const text = prompt('Paste a previously exported Pal list:');
  if (!text) return;
  try {
    JSON.parse(text);
    localStorage.setItem(STORAGE_KEY, text);
    state.inventory = load();
    renderInventory();
    renderTargetAdvice();
  } catch {
    alert('That does not look like an exported list.');
  }
});

/* ------------------------------------------- advice about the target ask */

function renderTargetAdvice() {
  const host = $('target-advice');
  const notes = [];
  const owned = new Set(state.inventory.flatMap((e) => e.passives));

  for (const index of state.targetPassives) {
    if (owned.has(index)) continue;
    const passive = db.passives[index];
    const how = obtainability(db, index);
    const sources = how.sources.slice(0, 6).join(', ');

    if (sources) {
      notes.push([
        'good',
        `<strong>${passive.name}</strong> isn’t on any Pal in your list, but ${how.sources.length === 1 ? 'one species is' : 'these are'} born with it: ` +
        `${sources}${how.sources.length > 6 ? ', and others' : ''}. Catch one and the planner can breed it in.`,
      ]);
    } else if (how.randomInheritable) {
      const odds = randomRollChance(passive.randomWeight, db.randomPoolWeight);
      notes.push([
        'warn',
        `<strong>${passive.name}</strong> isn’t on any Pal in your list and no species is born with it. ` +
        `It can still turn up on its own, but only on about ${pct(odds)} of eggs${how.rare ? ' — it is on the rare table' : ''}. ` +
        'Hatch until one appears, then add that Pal to your list.',
      ]);
    } else {
      notes.push([
        'bad',
        `<strong>${passive.name}</strong> can never appear from a breeding roll and no species is born with it. ` +
        'It has to come from a Pal that already has it — catch one holding it' +
        (passive.surgeryItem ? ', or apply it with a passive-skill surgery.' : '.'),
      ]);
    }
  }

  const target = db.palByName.get($('target-pal').value.trim());
  if (target !== undefined) {
    const pairs = db.parentsOf(target);
    if (pairs.length === 1 && pairs[0][0] === target && pairs[0][1] === target) {
      notes.push([
        'bad',
        `<strong>${db.pals[target].name}</strong> only hatches from two of its own kind, so no other species can carry a passive into its line. ` +
        'The only way to improve one is to breed two ' + db.pals[target].name + 's that already have the passives you want.',
      ]);
    }
  }

  if (notes.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.replaceChildren(
    el('h2', {}, 'Before you start'),
    ...notes.map(([kind, html]) => {
      const node = el('div', { className: `note ${kind}` });
      node.innerHTML = html;
      return node;
    }),
  );
}

$('target-pal').addEventListener('change', renderTargetAdvice);

/* ----------------------------------------------------------------- solving */

$('solve').addEventListener('click', async () => {
  const target = db.palByName.get($('target-pal').value.trim());
  if (target === undefined) {
    $('target-pal').focus();
    return;
  }

  const button = $('solve');
  button.disabled = true;
  $('solve-progress').textContent = 'Searching…';

  const options = {
    maxSteps: Number($('opt-maxsteps').value),
    allowWild: $('opt-wild').checked,
    maxJunk: $('opt-clean').checked ? 0 : 4,
    objective: $('opt-objective').value,
  };

  try {
    const result = await solve({
      db,
      inventory: state.inventory,
      target: { pal: target, passives: state.targetPassives },
      options,
      onProgress: ({ round: r, candidates }) => {
        $('solve-progress').textContent = `Round ${r} — ${candidates.toLocaleString()} routes explored…`;
      },
    });
    renderResults(result, target, options);
  } finally {
    button.disabled = false;
    $('solve-progress').textContent = '';
  }
});

function renderResults({ plans }, target, options) {
  const host = $('results');
  host.hidden = false;
  const targetName = db.pals[target].name;

  if (plans.length === 0) {
    host.replaceChildren(
      el('h2', {}, 'No route found'),
      el('div', { className: 'note bad' },
        `Nothing in your list can reach ${targetName} with those passives within ${options.maxSteps} steps. ` +
        'Raise the step limit, allow catching wild Pals, or add a Pal that already carries one of the passives.'),
    );
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const fewestSteps = Math.min(...plans.map((p) => p.steps));
  const fewestEggs = Math.min(...plans.map((p) => p.eggs));

  const nodes = [el('h2', {}, `${plans.length} route${plans.length === 1 ? '' : 's'} to ${targetName}`)];

  // If the top plan is not also the shortest or the cheapest, say so plainly
  // instead of letting the reader assume it is both.
  const best = plans[0];
  if (best.steps > fewestSteps || best.eggs > fewestEggs * 1.5) {
    nodes.push(el('div', { className: 'note' },
      `The best plan here is ranked by "${$('opt-objective').selectedOptions[0].textContent.toLowerCase()}". ` +
      `The shortest route in this list takes ${fewestSteps} step${fewestSteps === 1 ? '' : 's'}, ` +
      `and the cheapest averages about ${round(fewestEggs)} eggs.`));
  }

  plans.forEach((plan, i) => nodes.push(renderPlan(plan, i === 0)));
  host.replaceChildren(...nodes);
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function palLabel(candidate) {
  const node = el('span', {}, el('span', { className: 'pal' }, db.pals[candidate.sp].name));
  if (candidate.mask) {
    // Nothing to show per-passive here; the summary below lists them.
  }
  return node;
}

function sexOf(gender) {
  return gender === MALE ? 'male' : gender === FEMALE ? 'female' : null;
}

function renderPlan(plan, isBest) {
  const steps = planSteps(plan);
  const roots = planRoots(plan);
  const owned = roots.filter((r) => r.origin?.kind === 'owned');
  const wild = roots.filter((r) => r.origin?.kind === 'wild');

  const header = el('header', {}, [
    el('div', {}, [
      el('strong', {}, isBest ? 'Best route' : `Alternative`),
      plan.steps === 0 ? el('span', { className: 'gender' }, ' — you already have this Pal') : '',
    ]),
    el('div', { className: 'stats' }, [
      el('span', {}, [el('b', {}, String(plan.steps)), ' breeding step', plan.steps === 1 ? '' : 's']),
      el('span', {}, [el('b', {}, `~${round(plan.eggs)}`), ' eggs on average']),
      el('span', {}, [el('b', {}, String(wild.length)), ' to catch']),
    ]),
  ]);

  const list = el('ol', {}, steps.map((step) => {
    const { a, b, chance, eggsHere, childGender } = step.from;
    const sex = sexOf(childGender);
    // The step number is the ::before counter, which is itself a grid item, so
    // the row has exactly two children of its own.
    return el('li', {}, [
      el('span', {}, [
        palLabel(a), el('span', { className: 'cross' }, '×'), palLabel(b),
        el('span', { className: 'arrow' }, '→'),
        el('span', { className: 'pal' }, db.pals[step.sp].name),
        sex ? el('span', { className: 'gender' }, `(${sex})`) : '',
      ]),
      el('span', { className: `odds${chance < 0.05 ? ' thin' : ''}` }, `${pct(chance)} per egg · ~${round(eggsHere)} eggs`),
    ]);
  }));

  const startBits = [];
  if (owned.length) {
    const names = owned.map((r) => {
      const entry = state.inventory[r.origin.entry];
      const sex = entry?.gender === 'M' ? ' (male)' : entry?.gender === 'F' ? ' (female)' : '';
      return db.pals[r.sp].name + sex;
    });
    startBits.push(el('div', {}, [el('b', {}, 'From your list: '), names.join(', ')]));
  }
  if (wild.length) {
    const counts = new Map();
    for (const r of wild) counts.set(r.sp, (counts.get(r.sp) ?? 0) + 1);
    const names = [...counts].map(([sp, n]) => {
      const pal = db.pals[sp];
      const has = pal.guaranteed.length ? ` — born with ${pal.guaranteed.map((id) => db.passives[db.passiveById.get(id)]?.name).filter(Boolean).join(', ')}` : '';
      return `${pal.name}${n > 1 ? ` ×${n}` : ''}${has}`;
    });
    startBits.push(el('div', { style: 'margin-top:4px' }, [el('b', {}, 'Catch or already have: '), names.join('; ')]));
  }

  return el('div', { className: `plan${isBest ? ' best' : ''}` }, [
    header,
    steps.length ? list : el('p', { className: 'empty', style: 'padding:12px 14px' }, 'No breeding needed.'),
    startBits.length ? el('div', { className: 'startlist' }, startBits) : '',
  ]);
}

/* ------------------------------------------------------- passive planner */

for (const role of ROLES) $('role').append(el('option', { value: role.id, textContent: role.label }));
for (const task of WORK_TASKS) $('work-task').append(el('option', { value: task, textContent: task }));
$('element').append(el('option', { value: '', textContent: 'Not sure / not relevant' }));
for (const element of ELEMENTS) $('element').append(el('option', { value: element, textContent: element }));

function renderLoadout() {
  const role = ROLES.find((r) => r.id === $('role').value);
  $('wrap-task').hidden = role.id !== 'base';
  $('wrap-element').hidden = role.id !== 'combat';

  const workTask = role.id === 'base' ? $('work-task').value : null;
  const element = role.id === 'combat' ? ($('element').value || null) : null;
  const result = recommendPassives(db, { role, element, workTask, breedableOnly: $('opt-seedable').checked });

  const top = result.loadout[0]?.score ?? 1;
  const slots = result.loadout.map((entry, i) => el('div', { className: 'slot' }, [
    el('div', { className: 'rank' }, String(i + 1)),
    el('div', {}, [
      el('div', { className: 'name' }, entry.passive.name),
      el('div', { className: 'desc' }, entry.passive.description.replace(/\n/g, ' · ')),
      el('div', { className: 'why' }, describeSourcing(entry.obtain)),
      el('div', { className: 'bar', style: `width:${Math.max(4, (entry.score / top) * 100)}%` }),
    ]),
    el('div', { className: 'score' }, entry.score.toFixed(0)),
  ]));

  $('loadout').replaceChildren(
    el('h2', {}, `Best four for a ${role.label.toLowerCase()} Pal${workTask ? ` doing ${workTask}` : ''}`),
    el('p', { className: 'hint' }, role.blurb),
    ...(slots.length ? slots : [el('p', { className: 'empty' }, 'No passive helps with this job.')]),
    el('div', { style: 'margin-top:14px' }, el('button', {
      className: 'btn small',
      textContent: 'Plan a breeding line for these four',
      onclick: () => {
        state.targetPassives = result.loadout.map((e) => e.index);
        renderTargetPassives();
        renderTargetAdvice();
        $('tab-plan').click();
        $('target-pal').focus();
      },
    })),
  );

  const extras = [el('h2', {}, 'Runners-up'), el('p', { className: 'hint' }, 'Worth taking if a top pick is out of reach.')];
  extras.push(result.alternatives.length
    ? el('table', {}, el('tbody', {}, result.alternatives.map((entry) => el('tr', {}, [
        el('td', {}, [
          el('div', { className: 'pal' }, entry.passive.name),
          el('div', { className: 'desc', style: 'font-size:12.5px;color:var(--ink-2)' }, entry.passive.description.replace(/\n/g, ' · ')),
        ]),
        el('td', { className: 'num' }, entry.score.toFixed(0)),
      ]))))
    : el('p', { className: 'empty' }, 'Nothing else contributes.'));

  if (result.avoid.length) {
    extras.push(el('h3', { style: 'margin-top:18px' }, 'Actively bad here'));
    extras.push(el('div', { className: 'tags', style: 'margin-top:8px' },
      result.avoid.map((e) => el('span', { className: 'tag bad', title: e.passive.description }, e.passive.name))));
  }

  for (const note of result.notes) extras.push(el('div', { className: 'note', style: 'margin-top:14px' }, note));

  if (role.id === 'base' && workTask) {
    const best = bestPalsForTask(db, workTask, 10);
    extras.push(el('h3', { style: 'margin-top:18px' }, `Best Pals for ${workTask}`));
    extras.push(el('table', {}, el('tbody', {}, best.map((e) => el('tr', {}, [
      el('td', {}, e.pal.name),
      el('td', { className: 'num' }, `level ${e.level}`),
    ])))));
  }

  $('loadout-extras').replaceChildren(...extras);
}

function describeSourcing(how) {
  if (how.sources.length) {
    const shown = how.sources.slice(0, 3).join(', ');
    return `Born on ${shown}${how.sources.length > 3 ? ` and ${how.sources.length - 3} more` : ''} — catch one to seed a line.`;
  }
  if (how.randomInheritable) {
    return how.rare ? 'Can appear on its own, but it is on the rare roll table.' : 'Can appear on its own from a breeding roll.';
  }
  return 'Never appears from a breeding roll — inherit it from a caught Pal that has it' + (how.surgeryItem ? ', or apply a surgery.' : '.');
}

for (const id of ['role', 'work-task', 'element', 'opt-seedable']) $(id).addEventListener('change', renderLoadout);

/* -------------------------------------------------------- combo lookup */

function renderCombo() {
  const a = db.palByName.get($('combo-a').value.trim());
  const b = db.palByName.get($('combo-b').value.trim());
  const host = $('combo-out');
  if (a === undefined || b === undefined) {
    host.replaceChildren(el('p', { className: 'empty' }, 'Pick two Pals.'));
    return;
  }

  const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
  const split = db.genderSplits.get(key);
  if (split) {
    host.replaceChildren(
      el('div', { className: 'note warn' }, 'This pair is the one case where the result depends on which parent is female:'),
      ...split.map((o) => el('p', {},
        `${db.pals[o.parents[0]].name} (${o.genders[0].toLowerCase()}) × ${db.pals[o.parents[1]].name} (${o.genders[1].toLowerCase()}) → ${db.pals[o.child].name}`)),
    );
    return;
  }

  const child = db.pals[db.childOf(a, b)];
  host.replaceChildren(
    el('p', { style: 'font-size:17px' }, [
      el('span', { className: 'pal' }, db.pals[a].name),
      el('span', { className: 'cross' }, ' × '),
      el('span', { className: 'pal' }, db.pals[b].name),
      el('span', { className: 'arrow' }, ' → '),
      el('span', { className: 'pal' }, child.name),
    ]),
    child.guaranteed.length
      ? el('div', { className: 'note good' },
          `${child.name} is always born with ${child.guaranteed.map((id) => db.passives[db.passiveById.get(id)]?.name).filter(Boolean).join(', ')}.`)
      : '',
  );
}

function renderParents() {
  const child = db.palByName.get($('combo-child').value.trim());
  const host = $('combo-parents');
  if (child === undefined) {
    host.replaceChildren(el('p', { className: 'empty' }, 'Pick a Pal.'));
    return;
  }
  const pairs = db.parentsOf(child);
  const shown = pairs.slice(0, 60);
  host.replaceChildren(
    el('p', { className: 'hint' }, `${pairs.length} pair${pairs.length === 1 ? '' : 's'} produce ${db.pals[child].name}${pairs.length > shown.length ? `; showing the first ${shown.length}` : ''}.`),
    el('table', {}, el('tbody', {}, shown.map(([a, b]) => el('tr', {}, [
      el('td', {}, `${db.pals[a].name} × ${db.pals[b].name}`),
    ])))),
  );
}

for (const id of ['combo-a', 'combo-b']) $(id).addEventListener('change', renderCombo);
$('combo-child').addEventListener('change', renderParents);

/* ------------------------------------------------------------ first paint */

renderInventory();
renderTargetAdvice();
renderLoadout();
renderCombo();
renderParents();
