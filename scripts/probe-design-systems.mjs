// Probes how claude.ai/design exposes account-level design systems: which Omelette RPCs the
// page calls while the "Design systems" surface renders, and the raw field names those RPCs
// return. Read-only — it never uploads anything.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { omelette } from '../src/rpc.mjs';
import { ensureSession, withOperationPage } from '../src/session.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = process.env.CLAUDE_DESIGN_EVIDENCE_DIR
  || path.resolve(repoRoot, '../theseeker/.omo/evidence/design-gallery-claude-sync');
const RPC_METHOD_RE = /OmeletteService\/([A-Za-z]+)/;
const SETTLE_MS = 6_000;

function fieldUnion(items) {
  const keys = new Set();
  for (const item of items) for (const key of Object.keys(item ?? {})) keys.add(key);
  return [...keys].sort();
}

function byType(items) {
  const groups = {};
  for (const item of items) {
    const type = String(item?.type ?? 'UNKNOWN');
    (groups[type] ||= []).push(item);
  }
  return Object.fromEntries(Object.entries(groups).map(([type, group]) => [type, { count: group.length, fields: fieldUnion(group), sample: group[0] }]));
}

async function designSystemTabs(page) {
  return page.locator('a, button, [role="tab"]').filter({ hasText: /design system/i }).evaluateAll((elements) => elements.map((element) => ({
    tag: element.tagName.toLowerCase(),
    text: element.textContent?.trim().slice(0, 80) || '',
    href: element.getAttribute('href'),
    role: element.getAttribute('role'),
  })));
}

async function probe(session, page) {
  const rpcCalls = [];
  const onRequest = (request) => {
    const match = RPC_METHOD_RE.exec(request.url());
    if (match) rpcCalls.push({ method: match[1], url: request.url(), httpMethod: request.method() });
  };
  page.on('request', onRequest);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(SETTLE_MS);
  const tabs = await designSystemTabs(page);
  page.off('request', onRequest);

  const raw = await omelette(page, 'ListProjects', {}, session.org);
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    listProjectsUrl: 'https://claude.ai/design/anthropic.omelette.api.v1alpha.OmeletteService/ListProjects',
    responseFields: fieldUnion([raw]),
    itemCount: items.length,
    itemsByType: byType(items),
    designSystems: items.filter((item) => item?.type === 'PROJECT_TYPE_DESIGN_SYSTEM'),
    observedRpcMethods: [...new Set(rpcCalls.map((call) => call.method))].sort(),
    rpcCalls,
    designSystemTabs: tabs,
  };
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const session = await ensureSession({ visible: false });
  const evidence = await withOperationPage(session, (page) => probe(session, page));
  await writeFile(path.join(evidenceDir, 't7-probe-design-systems.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
