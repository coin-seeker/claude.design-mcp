const MODEL_MAP = {
  opus: { uiLabel: 'Opus 4.8', apiId: 'claude-opus-4-8' },
  'claude-opus-4-8': { uiLabel: 'Opus 4.8', apiId: 'claude-opus-4-8' },
  'anthropic/claude-opus-4-8': { uiLabel: 'Opus 4.8', apiId: 'claude-opus-4-8' },
  sonnet: { uiLabel: 'Sonnet 5', apiId: 'claude-sonnet-5' },
  'claude-sonnet-5': { uiLabel: 'Sonnet 5', apiId: 'claude-sonnet-5' },
  'anthropic/claude-sonnet-5': { uiLabel: 'Sonnet 5', apiId: 'claude-sonnet-5' },
};

const SUPPORTED_MODELS = Object.keys(MODEL_MAP).join(', ');

export function resolveModel(model) {
  const requested = String(model).trim();
  const resolved = MODEL_MAP[requested.toLowerCase()];
  if (!resolved) throw new Error(`Unsupported model "${requested}". Supported: ${SUPPORTED_MODELS}`);
  return resolved;
}

export function resolveOptionalModel(model) {
  return model ? resolveModel(model) : null;
}

export function withResolvedModel(result, resolvedModel) {
  return resolvedModel ? { ...result, model: resolvedModel.apiId } : result;
}

export async function applyModelToPage(page, model) {
  const { uiLabel } = resolveModel(model);
  const modelButton = page.locator('button[title="Change model"]').first();
  await modelButton.waitFor({ state: 'visible', timeout: 5_000 });
  await modelButton.click();

  const modelOption = page.locator('[role="menuitemradio"]').filter({ hasText: uiLabel }).first();
  await modelOption.waitFor({ state: 'visible', timeout: 5_000 });
  await modelOption.click();

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

  await page.locator('button[title="Change model"]').filter({ hasText: uiLabel }).first()
    .waitFor({ state: 'visible', timeout: 10_000 });
}
