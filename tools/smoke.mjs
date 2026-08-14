#!/usr/bin/env node
// Drives the real page in a real browser and fails on any console error.
// Needs a static server on http://localhost:8765 (see `npm run serve`).

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL ?? 'http://localhost:8765/index.html';

// Use whichever Chromium this machine already has rather than downloading one.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const step = async (label, fn) => {
  const before = problems.length;
  await fn();
  console.log(`${problems.length === before ? 'ok  ' : 'FAIL'}  ${label}`);
};

await page.goto(BASE, { waitUntil: 'networkidle' });

await step('page loads and builds its pickers', async () => {
  // datalist options are never rendered, so wait for them attached, not visible.
  await page.waitForSelector('#pal-list option', { state: 'attached' });
  const pals = await page.locator('#pal-list option').count();
  const passives = await page.locator('#passive-list option').count();
  if (pals !== 299) problems.push(`expected 299 Pals in the picker, saw ${pals}`);
  if (passives !== 115) problems.push(`expected 115 passives in the picker, saw ${passives}`);
});

await step('adds a Pal to the inventory', async () => {
  await page.fill('#own-pal', 'Anubis');
  await page.fill('#own-passive', 'Musclehead');
  await page.press('#own-passive', 'Enter');
  await page.selectOption('#own-gender', 'M');
  await page.click('#own-add');
  await page.waitForSelector('#inventory table');

  await page.fill('#own-pal', 'Anubis');
  await page.fill('#own-passive', 'Ferocious');
  await page.press('#own-passive', 'Enter');
  await page.selectOption('#own-gender', 'F');
  await page.click('#own-add');

  const rows = await page.locator('#inventory tbody tr').count();
  if (rows !== 2) problems.push(`expected 2 inventory rows, saw ${rows}`);
});

await step('solves a one-step plan and renders it', async () => {
  await page.fill('#target-pal', 'Anubis');
  await page.dispatchEvent('#target-pal', 'change');
  for (const name of ['Musclehead', 'Ferocious']) {
    await page.fill('#target-passive', name);
    await page.press('#target-passive', 'Enter');
  }
  await page.click('#solve');
  await page.waitForSelector('#results .plan', { timeout: 60000 });

  const text = await page.locator('#results').innerText();
  if (!/1 breeding step/.test(text)) problems.push(`expected a one-step plan, got:\n${text.slice(0, 400)}`);
  if (!/Anubis/.test(text)) problems.push('plan does not mention the target Pal');
});

await step('warns when a wanted passive has no source in the list', async () => {
  await page.fill('#target-passive', 'Legend');
  await page.press('#target-passive', 'Enter');
  await page.waitForSelector('#target-advice:not([hidden])');
  const text = await page.locator('#target-advice').innerText();
  if (!/Legend/.test(text)) problems.push('expected advice about Legend');
});

await step('recommends passives for each role', async () => {
  await page.click('#tab-passives');
  for (const role of ['combat', 'mount', 'base', 'breeding', 'support']) {
    await page.selectOption('#role', role);
    await page.waitForTimeout(60);
    const slots = await page.locator('#loadout .slot').count();
    if (slots === 0) problems.push(`role ${role} produced no recommendations`);
  }
  await page.selectOption('#role', 'base');
  await page.selectOption('#work-task', 'Mining');
  await page.waitForTimeout(60);
  const extras = await page.locator('#loadout-extras').innerText();
  if (!/Best Pals for Mining/.test(extras)) problems.push('missing the best-Pals-for-task table');
});

await step('hands a loadout to the planner', async () => {
  await page.click('text=Plan a breeding line for these four');
  await page.waitForSelector('#view-plan:not([hidden])');
  const chips = await page.locator('#target-passive-tags .tag').count();
  if (chips !== 4) problems.push(`expected 4 wanted passives carried across, saw ${chips}`);
});

await step('looks up a breeding combo', async () => {
  await page.click('#tab-combos');
  await page.fill('#combo-a', 'Relaxaurus');
  await page.dispatchEvent('#combo-a', 'change');
  await page.fill('#combo-b', 'Sparkit');
  await page.dispatchEvent('#combo-b', 'change');
  const text = await page.locator('#combo-out').innerText();
  if (!/Relaxaurus Lux/.test(text)) problems.push(`expected Relaxaurus Lux, got: ${text}`);

  await page.fill('#combo-child', 'Anubis');
  await page.dispatchEvent('#combo-child', 'change');
  const parents = await page.locator('#combo-parents').innerText();
  if (!/pairs? produce Anubis/.test(parents)) problems.push(`parent list did not render: ${parents}`);
});

await step('survives a reload with the saved inventory', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#inventory table');
  const rows = await page.locator('#inventory tbody tr').count();
  if (rows !== 2) problems.push(`inventory did not persist, saw ${rows} rows`);
});

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nsmoke test passed');
