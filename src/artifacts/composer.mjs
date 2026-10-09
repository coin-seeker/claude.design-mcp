import { setTimeout as delay } from 'node:timers/promises';
import { homeUrl } from '../backend.mjs';
import { matchDesignSystem } from '../design-system.mjs';
import { selectModelCandidate, matchEffortOption } from '../model.mjs';
import { artifactUrl } from './listing.mjs';
import { parseDesignLocation } from './surface.mjs';

export const PICKER_MISSING = 'Design system picker is unavailable in this Cowork composer, so the design system cannot be (re)selected for this turn. Omit designSystem, or start a new artifact with design_create.';
const MODEL = '[data-testid=model-selector-dropdown]';
// Base UI keeps a closed popup mounted (data-closed) while its exit animation is pending, and a
// background tab never finishes that animation, so only items of an open popup (data-open) count.
const MODEL_RADIOS = '[role=menu][data-open]:not([data-nested]) [role=menuitemradio]';
const MODEL_ITEMS = '[role=menu][data-open]:not([data-nested]) [role=menuitem]';
const EFFORT_RADIOS = '[role=menu][data-open][data-nested] [role=menuitemradio]';
const DS_OPTIONS = '[role=menuitemcheckbox]';
// The trigger reads "Design system:\n<name>" with a selection and "No design system" without one
// (measured 2026-10-10); "Choose design system" is the older empty label.
const PICKER_TEXT = 'Choose design system|Design system:|No design system';
const PICKER = { selector: 'button', text: PICKER_TEXT };

async function poll(read, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(typeof message === 'function' ? message() : message);
}

// Self-contained callbacks are serialized by Playwright. No locator actions depend on rAF.
export function domClick(page, target) {
  return page.evaluate(({ selector, text, index = 0 }) => {
    const inOpenPopup = (element) => { const menu = element.closest?.('[role=menu]'); return !menu || menu.hasAttribute('data-open'); };
    const matches = [...document.querySelectorAll(selector)].filter((element) =>
      element.getClientRects().length && inOpenPopup(element) && (!text || new RegExp(text, 'i').test(element.innerText)));
    const element = matches[index];
    if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    element.click();
    return true;
  }, target);
}

async function clickRequired(page, target) {
  await poll(() => domClick(page, target), `Composer control unavailable: ${target.selector}`);
}

function triggerState(page, { selector, text }) {
  return page.evaluate(({ selector, text }) => {
    const trigger = [...document.querySelectorAll(selector)].find((element) =>
      element.getClientRects().length && (!text || new RegExp(text, 'i').test(element.innerText)));
    return trigger ? { expanded: trigger.getAttribute('aria-expanded') === 'true', label: trigger.getAttribute('aria-label') || trigger.innerText || '' } : null;
  }, { selector, text });
}

// Escape does not close these popups in a background tab; toggling the trigger does (aria-expanded).
async function setMenuOpen(page, trigger, open) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await triggerState(page, trigger);
    if (!state) throw new Error(`Composer control unavailable: ${trigger.selector}`);
    if (state.expanded === open) return;
    await domClick(page, trigger);
    await delay(400);
  }
  if ((await triggerState(page, trigger))?.expanded !== open) throw new Error(`Composer menu did not ${open ? 'open' : 'close'}: ${trigger.selector}`);
}

const closeQuietly = (page, trigger) => setMenuOpen(page, trigger, false).catch(() => {});

export async function waitForInput(page) {
  await poll(() => page.evaluate(() => !!document.querySelector('[data-testid=chat-input]')), 'Design composer input unavailable');
}

export async function openNewDesign(page) {
  await page.goto(homeUrl(), { waitUntil: 'domcontentloaded' });
  await clickRequired(page, { selector: 'button[aria-label="Design, New"]' });
  return poll(() => parseDesignLocation(page.url()), 'New Design artifact URL unavailable');
}

export async function openNewDesignSystem(page) {
  await page.goto('https://claude.ai/artifacts/design', { waitUntil: 'domcontentloaded' });
  await poll(() => page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((element) =>
      element.getClientRects().length && element.innerText.trim() === 'Design System' && !element.disabled);
    if (!button) return false;
    button.click();
    return true;
  }), 'New Design System card unavailable');
  return poll(() => parseDesignLocation(page.url()), 'New Design System URL unavailable');
}

export async function openDesignSystemChat(page, artifactId) {
  await page.goto(artifactUrl(artifactId), { waitUntil: 'domcontentloaded' });
  await clickRequired(page, { selector: 'button[aria-label^="Claude와 채팅"], button[aria-label^="Chat with Claude"]' });
  return poll(() => {
    const location = parseDesignLocation(page.url());
    return location?.projectId === artifactId ? location : null;
  }, 'Design System chat URL unavailable');
}

export async function attachFile(page, filePath, name) {
  await page.setInputFiles('[data-testid=file-upload]', filePath);
  await poll(() => page.evaluate((filename) => [...document.querySelectorAll('[data-testid=file-thumbnail]')]
    .some((element) => element.innerText.includes(filename)), name), `Attachment thumbnail unavailable: ${name}`, 60_000);
}

export async function openDesignSession(page, sessionId, projectId) {
  const location = typeof sessionId === 'object' && sessionId !== null ? sessionId : { sessionId, projectId };
  await page.goto(artifactUrl(projectId ?? location.projectId, location.sessionId, location.chatId), { waitUntil: 'domcontentloaded' });
  await waitForInput(page);
  return parseDesignLocation(page.url());
}

export function pickerState(page) {
  return page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((element) =>
      element.getClientRects().length && new RegExp(text).test(element.innerText));
    return { visible: !!button, label: button?.innerText || '' };
  }, PICKER_TEXT);
}

function menuOptions(page, selector) {
  return page.evaluate((query) => [...document.querySelectorAll(query)]
    .filter((element) => { const menu = element.closest?.('[role=menu]'); return element.getClientRects().length && (!menu || menu.hasAttribute('data-open')); })
    .map((element) => ({ label: element.innerText, checked: element.getAttribute('aria-checked') === 'true' })), selector);
}

// A row reads "<check glyph>\n<name>\n, Enter selects only this one, …"; the name is its first real line.
export function designSystemRowName(label) {
  return String(label).replaceAll(/[\uE000-\uF8FF]/gu, '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

async function systemRows(page) {
  return (await menuOptions(page, DS_OPTIONS)).map((row) => ({ name: designSystemRowName(row.label), checked: row.checked }));
}

const checkedKey = (rows) => rows.map((row) => (row.checked ? '1' : '0')).join('');
const selectionError = (wanted, rows) => new Error(`Design system selection was not applied: wanted ${wanted ?? 'no design system'}; options: ${
  rows.map((row) => `${row.name}${row.checked ? ' [checked]' : ''}`).join(', ') || 'none'}`);

export async function applyDesignSystemArtifacts(page, requested) {
  if (!(await pickerState(page)).visible) throw new Error(PICKER_MISSING);
  try {
    await setMenuOpen(page, PICKER, true);
    let rows = await poll(async () => {
      const current = await systemRows(page);
      return current.length ? current : null;
    }, 'Design system options unavailable');
    const match = requested === null ? null : matchDesignSystem(rows.map((row, index) => ({ name: row.name, index })), requested);
    // Echo and verify the row's own name: a partial or differently-cased request is not what the trigger renders.
    const selected = match && { index: match.index, name: rows[match.index].name };
    const wanted = (index) => index === selected?.index;
    // A plain click selects ONLY an unchecked row and unchecks a checked one, so one click can flip
    // other rows too. Re-read the menu after every click instead of trusting the first read.
    for (let step = 0; !rows.every((row, index) => row.checked === wanted(index)); step++) {
      const index = selected && !rows[selected.index].checked ? selected.index : rows.findIndex((row, i) => row.checked && !wanted(i));
      if (index < 0 || step > rows.length) throw selectionError(selected?.name, rows);
      const before = checkedKey(rows);
      let latest = rows;
      await clickRequired(page, { selector: DS_OPTIONS, index });
      rows = await poll(async () => {
        latest = await systemRows(page);
        return latest.length === rows.length && checkedKey(latest) !== before ? latest : null;
      }, () => selectionError(selected?.name, latest).message);
    }
    await setMenuOpen(page, PICKER, false);
    await poll(async () => {
      const state = await pickerState(page);
      return selected ? state.label.includes(selected.name) : /No design system|Choose design system/.test(state.label);
    }, 'Design system picker label verification failed');
    return { name: selected?.name ?? null };
  } catch (error) {
    await closeQuietly(page, PICKER);
    throw error;
  }
}

async function confirmSelection(page) {
  // A dialog may mount after the radio click; bound this optional observation to 2 seconds.
  const deadline = Date.now() + 2_000;
  do {
    if (await domClick(page, { selector: '[data-testid=confirm-dialog-confirm]' })) return;
    await delay(500);
  } while (Date.now() < deadline);
}

const MODEL_TRIGGER = { selector: MODEL };
// The trigger label reads "<model> <effort>" (e.g. "모델: Opus 5.5 낮음"), so it verifies both selections.
const triggerLabel = async (page) => (await triggerState(page, MODEL_TRIGGER))?.label || '';

export async function applyModelArtifacts(page, request) {
  try {
    await setMenuOpen(page, MODEL_TRIGGER, true);
    const options = await poll(async () => {
      const rows = await menuOptions(page, MODEL_RADIOS);
      return rows.length ? rows : null;
    }, 'Model options unavailable');
    const selected = selectModelCandidate(options.map((row) => row.label), request);
    if (!options[selected.index].checked) {
      await clickRequired(page, { selector: MODEL_RADIOS, index: selected.index });
      await confirmSelection(page);
    }
    await setMenuOpen(page, MODEL_TRIGGER, false);
    await poll(async () => (await triggerLabel(page)).includes(selected.uiLabel), 'Model selection verification failed', 10_000);
    return { uiLabel: selected.uiLabel, apiId: selected.apiId };
  } catch (error) {
    await closeQuietly(page, MODEL_TRIGGER);
    throw error;
  }
}

async function openEffortMenu(page) {
  await setMenuOpen(page, MODEL_TRIGGER, true);
  const item = { selector: MODEL_ITEMS, text: '^(노력|Effort)' };
  await clickRequired(page, item);
  try {
    await poll(async () => (await menuOptions(page, EFFORT_RADIOS)).length > 0, 'Effort submenu unavailable', 2_000);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Effort submenu unavailable') throw error;
    await page.evaluate((query) => [...document.querySelectorAll(query)].find((element) => /^(노력|Effort)/.test(element.innerText))?.focus(), MODEL_ITEMS);
    await page.keyboard.press('ArrowRight');
  }
  return poll(async () => {
    const rows = await menuOptions(page, EFFORT_RADIOS);
    return rows.some((row) => matchEffortOption([row.label], 'low')) ? rows : null;
  }, 'Effort options unavailable');
}

export async function applyEffortArtifacts(page, effort) {
  try {
    const rows = await openEffortMenu(page);
    const selected = matchEffortOption(rows.map((row) => row.label), effort);
    if (!selected) throw new Error(`Effort "${effort}" not available. Available efforts: ${rows.map((row) => row.label).join(', ')}`);
    if (!rows[selected.index].checked) {
      await clickRequired(page, { selector: EFFORT_RADIOS, index: selected.index });
      await confirmSelection(page);
    }
    await setMenuOpen(page, MODEL_TRIGGER, false);
    await poll(async () => {
      const words = (await triggerLabel(page)).trim().split(/\s+/);
      return matchEffortOption([words.at(-1) || ''], selected.effort);
    }, 'Effort selection verification failed', 10_000);
    return selected.effort;
  } catch (error) {
    await closeQuietly(page, MODEL_TRIGGER);
    throw error;
  }
}

export async function sendPrompt(page, prompt) {
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid=chat-input]');
    if (!input) throw new Error('Design composer input unavailable');
    input.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
  });
  await page.keyboard.insertText(prompt);
  if (!(await domClick(page, { selector: '[data-testid=chat-input-send]' }))) await page.keyboard.press('Enter');
}
