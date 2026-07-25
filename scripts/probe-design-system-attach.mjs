// Diagnoses WHICH design system a submitted prompt is actually grounded in. Creates a scratch
// project, optionally runs the real applyDesignSystem, submits a throwaway prompt, then reports
// the Omelette calls the picker made, the design-system attachment the message carries, and the
// _ds/ snapshot the project received. Usage:
//   node scripts/probe-design-system-attach.mjs "Frontend Design System"   # with picker
//   node scripts/probe-design-system-attach.mjs                            # control, no picker
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { applyDesignSystem } from '../src/design-system.mjs';
import { decodeToBuffer, fileEntriesOf } from '../src/helpers.mjs';
import { listDesignSystems } from '../src/list-systems.mjs';
import { omelette } from '../src/rpc.mjs';
import { awaitDesignReady, ensureSession, withOperationPage } from '../src/session.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = process.env.CLAUDE_DESIGN_EVIDENCE_DIR
  || path.resolve(repoRoot, '../theseeker/.omo/evidence/design-gallery-claude-sync/t8-create-attach');
const RPC_RE = /OmeletteService\/([A-Za-z]+)/;
const requested = process.argv[2] || null;

function bodyText(request) {
  const raw = request.postDataBuffer?.();
  if (!raw) return '';
  try {
    return (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
  } catch {
    return raw.toString('utf8');
  }
}

// Naming which system's id a call carries is what separates "the picker committed my choice" from
// "the app fell back to the org default", so every call body is matched against the live systems.
function systemsIn(text, systems) {
  return systems.filter((system) => text.includes(system.id)).map((system) => system.name);
}

async function submitPrompt(page, prompt) {
  const editor = page.locator('div.ProseMirror[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(300);
  try { await page.locator('[data-testid="chat-send-button"]').first().click({ timeout: 3_000 }); }
  catch { await page.keyboard.press('Enter'); }
}

function attachments(data) {
  const out = [];
  for (const chat of Object.values(data.chats || {})) {
    for (const message of chat.messages || []) {
      for (const attachment of message.attachments || []) {
        const ids = [...new Set([...String(attachment.content || '').matchAll(/\/projects\/([0-9a-f-]{36})/g)].map((match) => match[1]))];
        out.push({ role: message.role, name: attachment.name || null, type: attachment.type || null, referencedProjects: ids, head: String(attachment.content || '').slice(0, 160).replace(/\n/g, ' ') });
      }
    }
  }
  return out;
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const session = await ensureSession({ visible: false });
  const evidence = await withOperationPage(session, async (page) => {
    const systems = await listDesignSystems({ ensureSession: async () => session, withOperationPage: async (_session, fn) => fn(page) });
    const created = await omelette(page, 'CreateProject', { name: `t8-attach-${requested ? 'picked' : 'control'}-${Date.now()}`, type: 'PROJECT_TYPE_PROJECT' }, session.org);
    const projectId = String(created?.projectId || '');
    const calls = [];
    const onRequest = (request) => {
      const match = RPC_RE.exec(request.url());
      if (!match) return;
      const text = bodyText(request);
      calls.push({ method: match[1], bodyBytes: text.length, systems: systemsIn(text, systems), body: text.replace(/[^\x20-\x7E]/g, '.').slice(0, 400) });
    };
    await awaitDesignReady(page, projectId);
    page.on('request', onRequest);
    const mark = calls.length;
    const selected = requested ? await applyDesignSystem(page, requested) : null;
    const afterPicker = calls.length;
    await submitPrompt(page, 'Reply with the single word ok.');
    await page.waitForTimeout(8_000);
    page.off('request', onRequest);
    const raw = await omelette(page, 'GetProjectData', { projectId }, session.org);
    const files = fileEntriesOf(await omelette(page, 'ListFiles', { projectId, depth: 100, offset: 0 }, session.org));
    return {
      capturedAt: new Date().toISOString(),
      requested,
      selected,
      projectId,
      pickerCalls: calls.slice(mark, afterPicker),
      submitCalls: calls.slice(afterPicker),
      attachments: attachments(JSON.parse(decodeToBuffer(raw.data).toString('utf8'))),
      dsSnapshots: files.map((file) => file.path).filter((file) => file.startsWith('_ds/')).map((file) => file.split('/')[1]).filter((value, index, list) => list.indexOf(value) === index),
    };
  });
  const slug = requested ? requested.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'control';
  await writeFile(path.join(evidenceDir, `t8-attach-${slug}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...evidence, pickerCalls: evidence.pickerCalls.map((call) => call.method), submitCalls: evidence.submitCalls.map((call) => call.method) }, null, 2)}\n`);
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
