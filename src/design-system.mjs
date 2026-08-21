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
const TRIGGER = '[data-testid="composer-ds-picker-trigger"]';
const MODAL = '[data-testid="ds-browse-modal"]';
const ROWS = 'button[aria-pressed]';
const PRESSED_ROWS = 'button[aria-pressed="true"]';
const CLEAR_LABEL = 'Clear selection';
const DONE_LABEL = 'Done';
const PICKER_TIMEOUT_MS = 15_000;
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
    if (await modal.locator(PRESSED_ROWS).count()) await modal.locator('button').filter({ hasText: CLEAR_LABEL }).first().click();
    await rows.nth(selected.index).click();
    // Single-select mode closes the modal on click; multi-select mode needs Done.
    if (await modal.isVisible()) {
      await modal.locator('button').filter({ hasText: DONE_LABEL }).first().click();
      await modal.waitFor({ state: 'hidden', timeout: timeoutMs });
    }
    modalOpen = false;
    // The trigger renders the selection, so its label is the proof exactly this system is attached.
    await page.locator(TRIGGER).filter({ hasText: selected.name }).first().waitFor({ state: 'visible', timeout: timeoutMs });
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
