// Chooses which design system a prompt is grounded in, through the composer UI (never an
// Omelette upload/attach RPC). Measured on the live app by scripts/probe-design-system-picker*.mjs:
//
//   trigger  [data-testid="composer-ds-picker-trigger"]  aria-label "Choose design systems";
//            its text is the current selection ("Design System", or "2 design systems").
//   modal    [data-testid="ds-browse-modal"] (role=dialog) with one button[aria-pressed] per
//            system, a "Clear selection" and a "Done" control.
//   scope    the trigger only exists while a project has produced no design yet (the composer
//            still shows its "Start with context" row); measured present on a fresh project and
//            on one whose only turn failed, absent once a project holds a generated design.
//
// Rows are additive and the org default arrives pre-selected, so attaching exactly one system
// means clearing first and then pressing the requested row.
import { decodeToBuffer } from './helpers.mjs';
import { logEvent } from './log.mjs';
import { cookieOrgExpression, omelette } from './rpc.mjs';
import { observeTurnAction } from './turn-network.mjs';

const TRIGGER = '[data-testid="composer-ds-picker-trigger"]';
const MODAL = '[data-testid="ds-browse-modal"]';
const ROWS = 'button[aria-pressed]';
const PRESSED_ROWS = 'button[aria-pressed="true"]';
const CLEAR_LABEL = 'Clear selection';
const DONE_LABEL = 'Done';
const PICKER_TIMEOUT_MS = 15_000;
// Each picker click persists through its own UpdateProjectDesignSystems POST, measured at
// ~400-500ms end to end; 8s is generous for that and still short enough that the fallback below
// costs a caller far less than the picker's own 15s DOM budget.
const PICKER_RPC_TIMEOUT_MS = 8_000;
const PICKER_RPC_SETTLE_MS = 2_000;
// Loading the chosen system's source into the composer is far slower and debounced, and how slow
// depends on what else touched the composer first: measured 6.7s after the picker on its own, but
// 16.6s in the real flow, where the model and effort pickers run before it. There is also a ~2.9s
// silent network gap in the middle, so neither a short sleep nor network idle would do. 45s leaves
// real headroom over the slow case; the fallback has to be long enough to be worth having.
const COMPOSER_LOAD_TIMEOUT_MS = 45_000;
const COMPOSER_LOAD_SETTLE_MS = 6_000;
const COMPOSER_POLL_MS = 500;
const PROJECT_URL_RE = /\/design\/p\/([0-9a-f-]{36})/i;
const PICKER_MISSING = 'Design system picker is unavailable in this composer. claude.ai only offers it while a project has produced no design yet, so pass designSystem on design_create (a fresh project) rather than on a project that already holds a design.';

// One fixed sentence for every violation of the choice contract, so callers and end-to-end probes can
// match the refusal on an exact string instead of parsing per-case wording.
export const DESIGN_SYSTEM_CHOICE_REQUIRED = 'designSystem is required: pass designSystem: "<name>" to ground this design in one of the account design systems, or withoutDesignSystem: true to opt out deliberately (optionally with withoutDesignSystemReason). Exactly one of the two, never both, never neither. Discover the available names with list_claude_synced_systems (dashboard Design System MCP) or design_system_list (this MCP).';
export const DESIGN_SYSTEM_REASON_WITHOUT_OPT_OUT = 'withoutDesignSystemReason is only allowed together with withoutDesignSystem: true. Drop the reason, or opt out explicitly with withoutDesignSystem: true.';

const provided = (value) => value !== undefined && value !== null;
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// Gate for the two tools that can still attach a system (design_create, design_variants): grounding is
// the default and skipping it has to be a deliberate, recorded decision. Callers run this before any
// session, browser page, or project exists, so a refusal leaves the account untouched.
// design_iterate is deliberately excluded: claude.ai hides the picker once a project holds a design,
// so there is nothing to choose there.
export function assertDesignSystemChoice(args = {}) {
  const wantsSystem = provided(args.designSystem);
  const wantsOptOut = provided(args.withoutDesignSystem);
  if (wantsSystem === wantsOptOut) throw new Error(DESIGN_SYSTEM_CHOICE_REQUIRED); // both, or neither
  if (wantsSystem) {
    const designSystem = trimmed(args.designSystem);
    if (!designSystem) throw new Error(DESIGN_SYSTEM_CHOICE_REQUIRED); // blank or non-string
    if (provided(args.withoutDesignSystemReason)) throw new Error(DESIGN_SYSTEM_REASON_WITHOUT_OPT_OUT);
    return { designSystem };
  }
  if (args.withoutDesignSystem !== true) throw new Error(DESIGN_SYSTEM_CHOICE_REQUIRED); // "true", 1, false
  const reason = trimmed(args.withoutDesignSystemReason);
  return reason ? { withoutDesignSystem: true, withoutDesignSystemReason: reason } : { withoutDesignSystem: true };
}

// The grounded branch carries nothing to echo: applyDesignSystem reports the canonical resolved name.
export function designSystemChoiceEcho(choice) {
  return choice?.withoutDesignSystem === true ? { ...choice } : {};
}

// Row text concatenates the name with its badge ("Design System" + "Org default"), and the
// modal's controls render icon-font glyphs from the private use area into textContent.
export function designSystemLabel(text) {
  return String(text)
    .replaceAll(/[\uE000-\uF8FF]/gu, '')
    .replace(/\s*Org default\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchDesignSystem(options, requested) {
  const target = String(requested).normalize('NFC').trim().toLowerCase();
  const key = (option) => option.name.normalize('NFC').toLowerCase();
  const exact = options.find((option) => key(option) === target);
  if (exact) return exact;
  const partial = options.filter((option) => key(option).includes(target));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Design system "${requested}" is ambiguous. Matches: ${partial.map((option) => option.name).join(', ')}`);
  throw new Error(`Design system "${requested}" not found. Available: ${options.map((option) => option.name).join(', ')}`);
}

const settle = (page, ms) => (typeof page.waitForTimeout === 'function'
  ? page.waitForTimeout(ms)
  : new Promise((resolve) => { setTimeout(resolve, ms); }));

// The composer applies a choice in two stages, and the DOM leads BOTH of them.
//
// Stage 1, per click: claude.ai persists the selection with one OmeletteService/
// UpdateProjectDesignSystems POST per click, while the trigger label re-renders long before those
// responses land. Returning on the DOM alone let submitPrompt's Chat POST overtake the persistence
// (measured: Chat POST ~340-390ms after this function returned, the second RPC response ~490ms
// after), so the turn was grounded in whatever system was stored BEFORE the picker ran — the org
// default — while every client-visible signal claimed success.
//
// Stage 2, once: the app then fetches the chosen system's source and loads it into the composer
// (measured 4.4s after the picker closed). Submitting between the two stages produced a turn with NO
// design system at all — the old selection was already dropped and the new one was not loaded yet —
// which is why stage 1 alone did not fix the bug. See awaitComposerAttachment below.
//
// Each click therefore awaits its OWN response. Wrapping the clear and select clicks in a single
// observation is NOT equivalent: it resolves on the first response and still races the second.
async function awaitRpc(page, label, kinds, action, timeoutMs, settleMs) {
  const requestTimeoutMessage = `design-system ${label} request was not observed within ${timeoutMs}ms`;
  const responseTimeoutMessage = `design-system ${label} response was not observed within ${timeoutMs}ms`;
  try {
    await observeTurnAction(page, action, {
      kinds,
      postOnly: true,
      requireResponse: true,
      timeoutMs,
      requestTimeoutMessage,
      responseTimeoutMessage,
    });
  } catch (error) {
    // Deliberately narrow: ONLY this helper's own two timeout messages are swallowed. A click that
    // failed, an RPC that failed, and an HTTP >=400 response all still surface.
    // Why swallow these at all: the wait is an observation of claude.ai's current behaviour, not a
    // contract it owes us. If the app ever stops firing a distinct RPC per click (batching them,
    // renaming the method, moving to a websocket), requireResponse would turn a silent
    // mis-grounding into a hard failure of EVERY grounded generation. Degrading to a fixed settle
    // delay keeps those callers working — slower, and still very likely correct.
    if (error?.message !== requestTimeoutMessage && error?.message !== responseTimeoutMessage) throw error;
    logEvent('design_system.persist_timeout', { label, timeoutMs, settleMs, reason: error.message });
    await settle(page, settleMs);
  }
}

const persistClick = (page, label, click, options) => awaitRpc(
  page, label, ['design-system'], click,
  Number(options.rpcTimeoutMs ?? PICKER_RPC_TIMEOUT_MS),
  Number(options.rpcSettleMs ?? PICKER_RPC_SETTLE_MS),
);

async function composerAttachmentName(page, projectId, org) {
  // A poll, so a transient RPC hiccup must not abort the picker; the deadline is the real bound.
  const raw = await omelette(page, 'GetProjectData', { projectId }, org).catch(() => null);
  if (!raw?.data) return null;
  try {
    const data = JSON.parse(decodeToBuffer(raw.data).toString('utf8'));
    return Object.values(data?.chats || {})
      .flatMap((chat) => chat?.composer?.attachments ?? [])
      .map((attachment) => attachment?.name)
      .find(Boolean) ?? null;
  } catch (error) {
    void error;
    return null;
  }
}

// Stage 2 has no network signal worth waiting on: the write that carries the system is a plain
// UpdateProjectData, which the app also fires for unrelated project state (measured: one lands ~260ms
// after the picker, the one carrying the 6KB composer attachment ~4.4s after). Waiting on the RPC
// name resolves on the wrong one and reproduces the empty attachment. So this waits on the state
// itself — the composer really naming the chosen system — which is what the Chat POST needs.
async function awaitComposerAttachment(page, name, options) {
  const timeoutMs = Number(options.composerTimeoutMs ?? COMPOSER_LOAD_TIMEOUT_MS);
  const settleMs = Number(options.composerSettleMs ?? COMPOSER_LOAD_SETTLE_MS);
  const pollMs = Number(options.composerPollMs ?? COMPOSER_POLL_MS);
  const projectId = (PROJECT_URL_RE.exec(typeof page.url === 'function' ? String(page.url()) : '') || [])[1] || null;
  const org = projectId ? await page.evaluate(cookieOrgExpression()).catch(() => null) : null;
  const deadline = Date.now() + timeoutMs;
  while (projectId && Date.now() < deadline) {
    const attached = await composerAttachmentName(page, projectId, org);
    if (attached && String(attached).includes(name)) return;
    await settle(page, pollMs);
  }
  // Same best-effort contract as the click waits: never fail a generation over a readiness probe.
  logEvent('design_system.composer_timeout', { projectId, name, timeoutMs, settleMs });
  await settle(page, settleMs);
}

async function openPicker(page, timeoutMs) {
  const trigger = page.locator(TRIGGER).first();
  try {
    await trigger.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    throw new Error(PICKER_MISSING);
  }
  await trigger.click();
  const modal = page.locator(MODAL).first();
  await modal.waitFor({ state: 'visible', timeout: timeoutMs });
  return modal;
}

export async function applyDesignSystem(page, requested, options = {}) {
  const timeoutMs = Number(options.timeoutMs || PICKER_TIMEOUT_MS);
  const modal = await openPicker(page, timeoutMs);
  let modalOpen = true;
  try {
    const rows = modal.locator(ROWS);
    await rows.first().waitFor({ state: 'visible', timeout: timeoutMs });
    const labels = await rows.allTextContents();
    const selected = matchDesignSystem(labels.map((text, index) => ({ name: designSystemLabel(text), index })), requested);
    if (await modal.locator(PRESSED_ROWS).count()) {
      await persistClick(page, 'clear', () => modal.locator('button').filter({ hasText: CLEAR_LABEL }).first().click(), options);
    }
    await persistClick(page, 'select', () => rows.nth(selected.index).click(), options);
    // Single-select mode closes the modal on click; multi-select mode needs Done.
    if (await modal.isVisible()) {
      await modal.locator('button').filter({ hasText: DONE_LABEL }).first().click();
      await modal.waitFor({ state: 'hidden', timeout: timeoutMs });
    }
    modalOpen = false;
    // The trigger renders the selection, so its label is the proof exactly this system is attached.
    await page.locator(TRIGGER).filter({ hasText: selected.name }).first().waitFor({ state: 'visible', timeout: timeoutMs });
    // ...but only that the CHOICE is made. Stage 2 is what makes the composer able to send it.
    await awaitComposerAttachment(page, selected.name, options);
    return { name: selected.name };
  } catch (error) {
    if (modalOpen) await page.keyboard.press('Escape').catch(() => {});
    throw error;
  }
}

// The turn owns the navigation that precedes submission, so the selection has to happen inside
// it (right before the prompt goes in) — an earlier click would be discarded by that reload.
export function designSystemHook(requested, apply = applyDesignSystem) {
  if (!requested) return { hook: undefined, attached: () => ({}) };
  let attached = null;
  return {
    hook: async (page) => { attached = (await apply(page, requested)).name; },
    attached: () => (attached ? { designSystem: attached } : {}),
  };
}
