import { designBackend } from './backend.mjs';
import { STANDALONE_IMPL, STANDALONE_TOOLS } from './standalone-tools.mjs';
import { ensureSession, withRpcPage } from './session.mjs';
import { artifactsList, artifactsGet, artifactsStatus, artifactsSystemList, artifactsDelete, artifactsLogin } from './artifacts/read-tools.mjs';
import { artifactsCheck } from './artifacts/check.mjs';
import { artifactsCreate, artifactsIterate, artifactsEdit, artifactsVariants } from './artifacts/generate.mjs';
import { pullArtifact } from './artifacts/pull.mjs';
import { resolveDesign } from './artifacts/listing.mjs';
import { artifactsPreview } from './artifacts/preview.mjs';
import { artifactsSystemSync } from './artifacts/ds-sync.mjs';

export { STANDALONE_IMPL };
export { createPool, variantPrompt, design_create, design_iterate, design_delete, design_variants, findOrCreateProject } from './standalone-tools.mjs';

async function artifactsPull(args = {}, overrides = {}) {
  const deps = { ensureSession, withRpcPage, resolveDesign, pullArtifact, ...overrides };
  const session = await deps.ensureSession({ visible: false });
  return deps.withRpcPage(session, async (page) => {
    const scoped = { ...session, page };
    const design = await deps.resolveDesign(scoped, { projectId: args.projectId, name: args.name }, deps);
    return deps.pullArtifact(scoped, design, args.dir, { ...deps, zip: Boolean(args.zip) });
  });
}

export const ARTIFACTS_IMPL = {
  design_login: artifactsLogin, design_list: artifactsList, design_create: artifactsCreate,
  design_iterate: artifactsIterate, design_pull: artifactsPull, design_preview: artifactsPreview,
  design_get: artifactsGet, design_status: artifactsStatus, design_check: artifactsCheck,
  design_edit: artifactsEdit, design_delete: artifactsDelete, design_variants: artifactsVariants,
  design_system_sync: artifactsSystemSync, design_system_list: artifactsSystemList,
};

export const IMPL = Object.fromEntries(Object.keys(STANDALONE_IMPL).map((name) => [name,
  (args, deps) => (designBackend() === 'artifacts' ? ARTIFACTS_IMPL : STANDALONE_IMPL)[name](args, deps),
]));

const ARTIFACTS_DESCRIPTIONS = {
  design_list: 'List Claude Design artifacts from the logged-in account. Read-only API in an existing background claude.ai page; never opens, focuses, or navigates a visible tab. Optional limit restricts the listing; details:true adds manifest file stats, restricted to detailsFor when supplied.',
  design_iterate: 'Submit a follow-up prompt to an existing Claude Design (claude.ai Design artifact + Cowork session). designSystem (re)selects the composer design system for this turn; it errors only if claude.ai shows no picker.',
  design_check: 'Poll the completion state of a pending design generation. API-only (Cowork session + artifact manifest); never opens a page. Returns status: generating | awaiting_input | done | no_output | interrupted | stalled. Permission requests are reported, never auto-approved.',
  design_edit: 'Applies literal edits by running an instructed Cowork turn (consumes usage) and verifies the result by re-reading the file; opens a background operation page.',
  design_variants: 'Submit multiple design variants of one prompt in parallel (max 3 concurrent), each as its own Design artifact; returns pending projectIds immediately (no preview) — poll each with design_check. designSystem grounds every variant. Grounding is mandatory: pass exactly one of designSystem or withoutDesignSystem: true.',
  design_system_sync: 'Create or update a Design System artifact from a materialized package directory (package.json + styles.css) through a Cowork session; never uses standalone claude.ai/design. Consumes usage. Defaults: model opus-5.5, effort extra, timeoutMs 900000.',
};

export function buildTools(backend) {
  return STANDALONE_TOOLS.map((tool) => ({ ...tool, description: backend === 'standalone' ? tool.description
    : ARTIFACTS_DESCRIPTIONS[tool.name] ?? tool.description.replaceAll('claude.ai/design', 'Claude Design (claude.ai Design artifact + Cowork session)') }));
}

// Invalid configuration must not prevent initialize/tools/list; dispatch still rejects it.
export const TOOLS = (() => {
  try { return buildTools(designBackend()); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return buildTools('artifacts');
  }
})();
