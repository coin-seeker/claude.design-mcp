const KNOWN_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const KNOWN_FAMILY_SET = new Set(KNOWN_FAMILIES);
const REQUEST_INPUTS = new WeakMap();
const MODEL_LABEL_PATTERN = new RegExp(`\\b(?:${KNOWN_FAMILIES.join('|')})\\s+\\d+(?:[.-]\\d+)*`, 'i');

function normalizeVersion(version) {
  const segments = version.split(/[.-]/).map(Number);
  while (segments.length > 1 && segments.at(-1) === 0) segments.pop();
  return segments.join('.');
}

export function parseModelRequest(input) {
  const requested = String(input).trim();
  const normalized = requested.toLowerCase()
    .replace(/^anthropic\//, '')
    .replace(/^claude-/, '');
  const match = normalized.match(/^([a-z]+)(?:[\s-]?(\d+(?:[.-]\d+)*))?$/);
  const family = match?.[1] || normalized.match(/^[a-z]+/)?.[0] || normalized;
  if (!KNOWN_FAMILY_SET.has(family)) {
    throw new Error(`Unknown model family "${family}". Known families: ${KNOWN_FAMILIES.join(', ')}`);
  }
  if (!match) throw new Error(`Invalid model "${requested}". Expected family or family+version`);
  const request = { family, version: match[2] ? normalizeVersion(match[2]) : null };
  REQUEST_INPUTS.set(request, requested);
  return request;
}

export function resolveOptionalModel(model) {
  return model ? parseModelRequest(model) : parseModelRequest('opus-5.5');
}

// claude.ai/design labels its effort levels Low / Medium / High / Extra / Max.
// API-style names (xhigh, extra-high) are aliases of the UI's "Extra".
const EFFORT_ALIASES = new Map([
  ['xhigh', 'extra'],
  ['extrahigh', 'extra'],
  ['maximum', 'max'],
  ['med', 'medium'],
]);
export const DEFAULT_EFFORT = 'high';
export const EFFORT_LABEL_ALIASES = new Map([
  ['낮음', 'low'], ['중간', 'medium'], ['높음', 'high'], ['엑스트라', 'extra'], ['최대', 'max'],
]);

export function normalizeEffort(value) {
  const compact = String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
  return EFFORT_LABEL_ALIASES.get(compact) ?? EFFORT_ALIASES.get(compact) ?? compact;
}

export function resolveEffort(_request, effort) {
  return effort ?? DEFAULT_EFFORT;
}

// A page reload resets the composer's effort to the site default (Medium), and claude.ai starts
// follow-up turns of its own (question-form Continue, interruption Resume) from whatever the
// composer shows. Remember each project's effort so those clicks can re-apply it first.
const PROJECT_EFFORT = new Map();

export function rememberProjectEffort(projectId, effort) {
  if (projectId && effort) PROJECT_EFFORT.set(String(projectId), effort);
}

export function projectEffort(projectId) {
  return PROJECT_EFFORT.get(String(projectId)) ?? DEFAULT_EFFORT;
}

// textContent glues badges onto the label ("MediumRecommended"), so stop at the next capital.
function effortLabelWord(label) {
  const text = String(label).trim();
  return [...EFFORT_LABEL_ALIASES.keys()].find((word) => text.startsWith(word))
    ?? text.match(/^[A-Za-z][a-z]*/)?.[0] ?? '';
}

export function matchEffortOption(labels, effort) {
  const requested = normalizeEffort(effort);
  const index = labels.findIndex((label) => normalizeEffort(effortLabelWord(label)) === requested);
  return index < 0 ? null : { index, effort: requested };
}

export function withResolvedModel(result, selectedModel) {
  return selectedModel ? { ...result, model: selectedModel.apiId } : result;
}

function compareVersions(left, right) {
  const leftSegments = left.split('.').map(Number);
  const rightSegments = right.split('.').map(Number);
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftSegments[index] || 0) - (rightSegments[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requestedLabel(request) {
  return REQUEST_INPUTS.get(request) || (request.version ? `${request.family} ${request.version}` : request.family);
}

function extractModelLabel(text) {
  return String(text).match(MODEL_LABEL_PATTERN)?.[0] || '';
}

export function selectModelCandidate(inputLabels, request) {
  const labels = inputLabels.map(extractModelLabel);
  const candidates = labels.flatMap((uiLabel, index) => {
    if (!uiLabel) return [];
    const parsed = parseModelRequest(uiLabel);
    return parsed.version ? [{ ...parsed, uiLabel, index }] : [];
  });
  const familyMatches = candidates.filter((candidate) => candidate.family === request.family);
  const selected = request.version
    ? familyMatches.find((candidate) => candidate.version === request.version)
    : familyMatches.sort((left, right) => compareVersions(right.version, left.version))[0];
  if (!selected) {
    throw new Error(`Model "${requestedLabel(request)}" not available. Available models: ${labels.filter(Boolean).join(', ')}`);
  }
  return { ...selected, apiId: `claude-${selected.family}-${selected.version.replaceAll('.', '-')}` };
}

async function confirmSelection(page) {
  const confirm = page.locator('[data-testid="confirm-dialog-confirm"]').first();
  try {
    await confirm.waitFor({ state: 'visible', timeout: 2_000 });
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return;
  }
  await confirm.click();
  await confirm.waitFor({ state: 'hidden', timeout: 10_000 });
}

export async function applyModelToPage(page, request) {
  const modelButton = page.locator('button[title="Change model"]').first();
  await modelButton.waitFor({ state: 'visible', timeout: 5_000 });
  await modelButton.click();
  let menuOpen = true;

  try {
    const menuItems = page.locator('[role="menuitemradio"]');
    await menuItems.first().waitFor({ state: 'visible', timeout: 5_000 });
    const selected = selectModelCandidate(await menuItems.allTextContents(), request);

    await menuItems.nth(selected.index).click();
    menuOpen = false;

    await confirmSelection(page);

    await page.locator('button[title="Change model"]').filter({ hasText: selected.uiLabel }).first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    return {
      uiLabel: selected.uiLabel,
      apiId: selected.apiId,
    };
  } catch (error) {
    if (menuOpen) await page.keyboard.press('Escape').catch(() => {});
    throw error;
  }
}

// required: the caller asked for this effort explicitly, so a miss must fail the turn before the
// prompt is sent instead of silently generating at whatever effort the composer already had.
export async function applyEffortToPage(page, effort, { required = false } = {}) {
  const modelButton = page.locator('button[title="Change model"]').first();
  try {
    await modelButton.waitFor({ state: 'visible', timeout: 5_000 });
    await modelButton.click();
    const effortItem = page.locator('[role="menuitem"]').filter({ hasText: /^Effort/i }).first();
    await effortItem.waitFor({ state: 'visible', timeout: 3_000 });
    await effortItem.click();

    const effortMenu = page.locator('[role="menu"][data-nested]').first();
    await effortMenu.waitFor({ state: 'visible', timeout: 3_000 });
    const menuItems = effortMenu.locator('[role="menuitemradio"]');
    const labels = await menuItems.allTextContents();
    const selected = matchEffortOption(labels, effort);
    if (!selected) {
      const available = labels.map(effortLabelWord).filter(Boolean).join(', ');
      throw new Error(`Effort "${effort}" not available. Available efforts: ${available}`);
    }

    await menuItems.nth(selected.index).click();
    await confirmSelection(page);
    await modelButton.filter({ hasText: selected.effort }).first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    return selected.effort;
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    if (required) throw error;
    return 'unavailable';
  }
}
