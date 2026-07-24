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
  return model ? parseModelRequest(model) : null;
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

export async function applyModelToPage(page, request) {
  const modelButton = page.locator('button[title="Change model"]').first();
  await modelButton.waitFor({ state: 'visible', timeout: 5_000 });
  await modelButton.click();
  let menuOpen = true;

  try {
    const menuItems = page.locator('[role="menuitemradio"]');
    await menuItems.first().waitFor({ state: 'visible', timeout: 5_000 });
    const labels = (await menuItems.allTextContents()).map(extractModelLabel);
    const candidates = labels.flatMap((uiLabel, index) => {
      try {
        const parsed = parseModelRequest(uiLabel);
        return parsed.version ? [{ ...parsed, uiLabel, index }] : [];
      } catch {
        return [];
      }
    });
    const familyMatches = candidates.filter((candidate) => candidate.family === request.family);
    const selected = request.version
      ? familyMatches.find((candidate) => candidate.version === request.version)
      : familyMatches.sort((left, right) => compareVersions(right.version, left.version))[0];

    if (!selected) {
      throw new Error(`Model "${requestedLabel(request)}" not available. Available models: ${labels.filter(Boolean).join(', ')}`);
    }

    await menuItems.nth(selected.index).click();
    menuOpen = false;

    const confirm = page.locator('[data-testid="confirm-dialog-confirm"]').first();
    let needsConfirmation = true;
    try {
      await confirm.waitFor({ state: 'visible', timeout: 2_000 });
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
      needsConfirmation = false;
    }
    if (needsConfirmation) {
      await confirm.click();
      await confirm.waitFor({ state: 'hidden', timeout: 10_000 });
    }

    await page.locator('button[title="Change model"]').filter({ hasText: selected.uiLabel }).first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    return {
      uiLabel: selected.uiLabel,
      apiId: `claude-${selected.family}-${selected.version.replaceAll('.', '-')}`,
    };
  } catch (error) {
    if (menuOpen) await page.keyboard.press('Escape').catch(() => {});
    throw error;
  }
}
