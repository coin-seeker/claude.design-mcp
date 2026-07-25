// Probes the design-system picker on the surface design_create actually uses: a FRESH project's
// empty composer ("Start with context" row). Dumps the Design system trigger, the modal it opens,
// the option rows, and what the trigger reads after a named system is selected. Creates one
// scratch project and deletes it again; it never submits a prompt.
// Re-run this whenever the composer changes and applyDesignSystem stops finding its selectors.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deleteProject } from '../src/pull.mjs';
import { omelette } from '../src/rpc.mjs';
import { awaitDesignReady, ensureSession, withOperationPage } from '../src/session.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = process.env.CLAUDE_DESIGN_EVIDENCE_DIR
  || path.resolve(repoRoot, '../theseeker/.omo/evidence/design-gallery-claude-sync/t8-create-attach');
const TARGET = process.env.CLAUDE_DESIGN_PROBE_SYSTEM || 'Frontend Design System';
const SETTLE_MS = 2_000;

const describe = (elements) => elements.map((element) => ({
  tag: element.tagName.toLowerCase(),
  text: element.textContent?.trim().slice(0, 140) || '',
  attributes: Object.fromEntries(element.getAttributeNames().map((name) => [name, element.getAttribute(name)])),
}));

function panelScript() {
  return (needle) => {
    const anchor = [...document.querySelectorAll('button, [role="option"], [role="menuitem"], div')]
      .find((element) => element.textContent?.trim() === needle);
    if (!anchor) return { found: false };
    const chain = [];
    let node = anchor;
    for (let depth = 0; depth < 7 && node?.parentElement; depth += 1) {
      node = node.parentElement;
      chain.push({ depth, tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), testid: node.getAttribute('data-testid'), classes: (node.className || '').toString().slice(0, 160) });
    }
    return { found: true, chain, html: node.outerHTML.slice(0, 24_000) };
  };
}

async function buttons(page) {
  return page.locator('button, [role="option"], [role="menuitem"], [role="menuitemradio"]').evaluateAll(describe);
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const session = await ensureSession({ visible: false });
  const evidence = await withOperationPage(session, async (page) => {
    const scoped = { ...session, page };
    const created = await omelette(page, 'CreateProject', { name: `t8-probe-scratch-${Date.now()}`, type: 'PROJECT_TYPE_PROJECT' }, session.org);
    const projectId = String(created?.projectId || '');
    const record = { projectId, capturedAt: new Date().toISOString() };
    try {
      await awaitDesignReady(page, projectId);
      await page.waitForTimeout(SETTLE_MS);
      record.emptyComposerButtons = await buttons(page);
      const trigger = page.locator('button').filter({ hasText: /design system/i }).first();
      record.triggerCount = await page.locator('button').filter({ hasText: /design system/i }).count();
      if (record.triggerCount) {
        await trigger.click();
        await page.waitForTimeout(SETTLE_MS);
        record.afterClickButtons = await buttons(page);
        record.panelFromBuiltin = await page.evaluate(panelScript(), 'Modernist');
        record.panelFromTarget = await page.evaluate(panelScript(), TARGET);
        await page.screenshot({ path: path.join(evidenceDir, 'fresh-project-picker-open.png'), fullPage: true });
        const option = page.locator('button, [role="option"], [role="menuitem"]').filter({ hasText: TARGET }).first();
        record.optionMatches = await page.locator('button, [role="option"], [role="menuitem"]').filter({ hasText: TARGET }).count();
        if (record.optionMatches) {
          await option.click();
          await page.waitForTimeout(SETTLE_MS);
          record.afterSelectButtons = await buttons(page);
          record.afterSelectTriggerText = await page.locator('button').filter({ hasText: /design system/i }).first().textContent().catch(() => null);
          await page.screenshot({ path: path.join(evidenceDir, 'fresh-project-picker-selected.png'), fullPage: true });
        }
      }
      return record;
    } finally {
      await deleteProject(scoped, projectId).catch((error) => { record.deleteError = String(error?.message || error); });
    }
  });
  await writeFile(path.join(evidenceDir, 't8-probe-picker-fresh.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write('written\n');
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
