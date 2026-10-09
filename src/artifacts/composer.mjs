import { setTimeout as delay } from 'node:timers/promises';
import { homeUrl } from '../backend.mjs';
import { designSystemLabel, matchDesignSystem } from '../design-system.mjs';
import { selectModelCandidate, matchEffortOption } from '../model.mjs';
import { artifactUrl } from './listing.mjs';

export const PICKER_MISSING = 'Design system picker is unavailable: claude.ai only offers it on an empty Design artifact, so pass designSystem on design_create (a new artifact) rather than on one that already holds a design.';
const MODEL = '[data-testid=model-selector-dropdown]';
const RADIO = '[role=menuitemradio]';
const PICKER = { selector: 'button', text: 'Choose design system|Design system:' };

async function poll(read, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(message);
}

// Self-contained callbacks are serialized by Playwright. No locator actions depend on rAF.
export function domClick(page, target) {
  return page.evaluate(({ selector, text, index = 0 }) => {
    const matches = [...document.querySelectorAll(selector)].filter((element) =>
      element.getClientRects().length && (!text || new RegExp(text, 'i').test(element.innerText)));
    const element = matches[index];
    if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    element.click();
    return true;
  }, target);
}

async function clickRequired(page, target) {
  await poll(() => domClick(page, target), `Composer control unavailable: ${target.selector}`);
}

export async function waitForInput(page) {
  await poll(() => page.evaluate(() => !!document.querySelector('[data-testid=chat-input]')), 'Design composer input unavailable');
}

export async function openNewDesign(page) {
  await page.goto(homeUrl(), { waitUntil: 'domcontentloaded' });
  await clickRequired(page, { selector: 'button[aria-label="Design, New"]' });
  const match = await poll(() => /\/cowork\/(cse_[A-Za-z0-9]+)\?artifact=([0-9a-f-]{36})/i.exec(page.url()), 'New Design artifact URL unavailable');
  return { sessionId: match[1], projectId: match[2] };
}

export async function openDesignSession(page, sessionId, projectId) {
  await page.goto(artifactUrl(projectId, sessionId), { waitUntil: 'domcontentloaded' });
  await waitForInput(page);
}

export function pickerState(page) {
  return page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((element) =>
      element.getClientRects().length && /Choose design system|Design system:/.test(element.innerText));
    return { visible: !!button, label: button?.innerText || '' };
  });
}

function menuOptions(page, selector) {
  return page.evaluate((query) => [...document.querySelectorAll(query)]
    .filter((element) => element.getClientRects().length)
    .map((element) => ({ label: element.innerText, checked: element.getAttribute('aria-checked') === 'true' })), selector);
}

export async function applyDesignSystemArtifacts(page, requested) {
  if (!(await pickerState(page)).visible) throw new Error(PICKER_MISSING);
  await clickRequired(page, PICKER);
  try {
    const selector = '[role=menuitemcheckbox]';
    const options = await poll(async () => {
      const rows = await menuOptions(page, selector);
      return rows.length ? rows : null;
    }, 'Design system options unavailable');
    const selected = requested === null ? null : matchDesignSystem(options.map((row, index) => ({ name: designSystemLabel(row.label), index })), requested);
    for (let index = 0; index < options.length; index++) {
      const wanted = index === selected?.index;
      if (options[index].checked !== wanted) {
        await clickRequired(page, { selector, index });
        await poll(async () => (await menuOptions(page, selector))[index]?.checked === wanted, 'Design system selection was not applied');
      }
    }
    await clickRequired(page, PICKER);
    await poll(async () => {
      const state = await pickerState(page);
      return selected ? state.label.includes(selected.name) : /Choose design system/.test(state.label);
    }, 'Design system picker label verification failed');
    return { name: selected?.name ?? null };
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
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

export async function applyModelArtifacts(page, request) {
  await clickRequired(page, { selector: MODEL });
  try {
    const options = await poll(async () => {
      const rows = await menuOptions(page, RADIO);
      return rows.length ? rows : null;
    }, 'Model options unavailable');
    const selected = selectModelCandidate(options.map((row) => row.label), request);
    await clickRequired(page, { selector: RADIO, index: selected.index });
    await confirmSelection(page);
    await clickRequired(page, { selector: MODEL });
    await poll(async () => (await menuOptions(page, RADIO)).some((row) => row.checked && row.label.includes(selected.uiLabel)), 'Model selection verification failed');
    await page.keyboard.press('Escape');
    return { uiLabel: selected.uiLabel, apiId: selected.apiId };
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
    throw error;
  }
}

async function openEffortMenu(page) {
  await clickRequired(page, { selector: MODEL });
  const target = { selector: '[role=menuitem]', text: '^(노력|Effort)' };
  await clickRequired(page, target);
  try {
    await poll(() => page.evaluate(() => [...document.querySelectorAll('[role=menu]')].filter((element) => element.getClientRects().length).length > 1), 'Effort submenu unavailable', 2_000);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Effort submenu unavailable') throw error;
    await page.evaluate(() => [...document.querySelectorAll('[role=menuitem]')].find((element) => /^(노력|Effort)/.test(element.innerText))?.focus());
    await page.keyboard.press('ArrowRight');
  }
  // Radix may portal the submenu rather than nesting it in the outer menu.
  return poll(async () => {
    const rows = await menuOptions(page, RADIO);
    return rows.some((row) => matchEffortOption([row.label], 'low')) ? rows : null;
  }, 'Effort options unavailable');
}

export async function applyEffortArtifacts(page, effort) {
  try {
    const rows = await openEffortMenu(page);
    const selected = matchEffortOption(rows.map((row) => row.label), effort);
    if (!selected) throw new Error(`Effort "${effort}" not available. Available efforts: ${rows.map((row) => row.label).join(', ')}`);
    await clickRequired(page, { selector: RADIO, index: selected.index });
    await confirmSelection(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await openEffortMenu(page);
    await poll(async () => (await menuOptions(page, RADIO)).some((row) => row.checked && matchEffortOption([row.label], selected.effort)), 'Effort selection verification failed');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    return selected.effort;
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
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
