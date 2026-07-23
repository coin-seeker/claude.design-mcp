import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { listProjects } from '../src/pull.mjs';
import { ensureSession } from '../src/session.mjs';
import { classifyTurnRequest } from '../src/turn-classify.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = process.env.CLAUDE_DESIGN_EVIDENCE_DIR
  || path.resolve(repoRoot, '../theseeker/.omo/evidence/claude-design-revival/T1');
const prompt = process.env.CLAUDE_DESIGN_PROBE_PROMPT
  || 'Reply briefly that the model probe was received. Do not change any design files.';
const requestedModel = process.env.CLAUDE_DESIGN_PROBE_MODEL || null;
const evidenceSuffix = requestedModel ? `-${requestedModel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';

function embeddedJson(text) {
  const modelStart = text.indexOf('{"model"');
  const start = modelStart >= 0 ? modelStart : text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  return null;
}

function parsePostData(request) {
  const raw = request.postDataBuffer();
  if (!raw) return { encoding: 'none', body: null };
  const gzip = raw[0] === 0x1f && raw[1] === 0x8b;
  const text = (gzip ? gunzipSync(raw) : raw).toString('utf8');
  try {
    return { encoding: gzip ? 'gzip' : 'identity', framing: 'json', body: JSON.parse(text) };
  } catch {
    const body = embeddedJson(text);
    return body
      ? { encoding: gzip ? 'gzip' : 'identity', framing: 'connect-protobuf', body }
      : { encoding: gzip ? 'gzip' : 'identity', framing: 'binary', body: text };
  }
}

function modelFields(value, currentPath = '$') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => modelFields(item, `${currentPath}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const itemPath = `${currentPath}.${key}`;
    const found = /model/i.test(key) ? [{ path: itemPath, value: item }] : [];
    return found.concat(modelFields(item, itemPath));
  });
}

async function inspectModelMenu(page) {
  const projectSelector = page.locator('button[title="Change model"]');
  const landingSelector = page.locator('button[aria-haspopup="menu"]').filter({ hasText: /Model/i });
  const selector = (await projectSelector.count() ? projectSelector : landingSelector).first();
  const selectorCount = await selector.count();
  if (!selectorCount) return { exists: false, controls: [], options: [] };

  await selector.click();
  const menu = page.locator('[role="menu"]').filter({ has: page.locator('[role="menuitemradio"]') }).first();
  await menu.waitFor({ state: 'visible', timeout: 5_000 });
  if (requestedModel) {
    const target = menu.locator('[role="menuitemradio"]').filter({ hasText: requestedModel }).first();
    await target.waitFor({ state: 'visible', timeout: 5_000 });
    await target.click();
    const confirm = page.locator('[data-testid="confirm-dialog-confirm"]');
    if (await confirm.count()) {
      await confirm.click();
      await confirm.waitFor({ state: 'hidden', timeout: 10_000 });
    }
    await selector.waitFor({ state: 'visible' });
    await selector.click();
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
  }
  const controls = await selector.evaluateAll((elements) => elements.map((element) => ({
    text: element.textContent?.trim() || '',
    ariaExpanded: element.getAttribute('aria-expanded'),
    ariaControls: element.getAttribute('aria-controls'),
  })));
  const options = await menu.locator('[role="menuitemradio"]').evaluateAll((elements) => elements.map((element) => ({
    text: element.textContent?.trim() || '',
    ariaChecked: element.getAttribute('aria-checked'),
    id: element.id || null,
  })));
  return { exists: true, controls, options };
}

async function submitPrompt(page, text) {
  await page.keyboard.press('Escape');
  const editor = page.locator('div.ProseMirror[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.insertText(text);
  try {
    await page.locator('[data-testid="chat-send-button"]').first().click({ timeout: 3_000 });
  } catch {
    await page.keyboard.press('Enter');
  }
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const session = await ensureSession({ visible: true });
  const projects = await listProjects(session, { refresh: true });
  const firstProject = projects[0];
  if (!firstProject) throw new Error('No Claude Design projects are available');

  const { page } = session;
  await page.goto('https://claude.ai/design', { waitUntil: 'domcontentloaded' });
  const project = page.getByRole('link', { name: firstProject.name, exact: true }).first();
  await project.waitFor({ state: 'visible', timeout: 30_000 });
  await project.click();
  await page.waitForURL((url) => url.pathname.includes(`/design/p/${firstProject.projectId}`), { timeout: 30_000 });
  await page.locator('div.ProseMirror[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 30_000 });

  const dom = await inspectModelMenu(page);
  await page.screenshot({ path: path.join(evidenceDir, `model-selector${evidenceSuffix}.png`), fullPage: true });

  const requests = [];
  let resolveChat;
  const chatCaptured = new Promise((resolve) => { resolveChat = resolve; });
  const onRequest = (request) => {
    const kind = classifyTurnRequest(request.url());
    if (request.method() !== 'POST' || (kind !== 'chat' && kind !== 'renew')) return;
    const postData = parsePostData(request);
    requests.push({ kind, url: request.url(), bodyEncoding: postData.encoding, bodyFraming: postData.framing, body: postData.body, modelFields: modelFields(postData.body) });
    if (kind === 'chat') resolveChat();
  };

  page.on('request', onRequest);
  try {
    await submitPrompt(page, prompt);
    await Promise.race([
      chatCaptured,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chat request was not observed within 30 seconds')), 30_000)),
    ]);
    await page.waitForTimeout(12_000);
  } finally {
    page.off('request', onRequest);
  }

  const evidence = {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    project: firstProject,
    requestedModel,
    dom,
    prompt,
    requests,
  };
  await writeFile(path.join(evidenceDir, `request-payloads${evidenceSuffix}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
