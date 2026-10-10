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
import { withAccount } from './accounts.mjs';
import { resolveAccountFor } from './account-routing.mjs';

export { resolveAccountFor } from './account-routing.mjs';

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
  (args = {}, deps) => {
    const backend = designBackend();
    const account = resolveAccountFor(name, args, deps);
    if (backend === 'standalone' && account === 'sub') throw new Error('sub account requires the artifacts backend');
    return withAccount(account, async () => {
      const result = await (backend === 'artifacts' ? ARTIFACTS_IMPL : STANDALONE_IMPL)[name](args, deps);
      if (backend === 'standalone') {
        if (name === 'design_list' || name === 'design_system_list') return result.map((item) => ({ ...item, account }));
        if (['design_login', 'design_status', 'design_system_sync'].includes(name)) return { ...result, account };
      }
      return result;
    });
  },
]));

const ARTIFACTS_DESCRIPTIONS = {
  design_login: 'Open Chrome for Design login; report account.',
  design_list: 'List artifacts. details/detailsFor add scoped file stats. Background API.',
  design_create: 'Create/reuse artifact; fresh forces new. Require designSystem XOR withoutDesignSystem:true. wait:false is async.',
  design_iterate: 'Follow-up prompt; designSystem reselects if picker exists. wait:false submits async.',
  design_pull: 'Download artifact by id/name. No dir/zip records revision. Background API.',
  design_preview: 'Headless artifact PNG; reports truncation at 20000h/10000w/40M pixels.',
  design_get: 'Read artifact file. Background API.',
  design_status: 'Conversation summary/last role. Background API.',
  design_check: 'API status: generating|awaiting_input|done|no_output|interrupted|stalled. Never auto-approve/resume.',
  design_edit: 'Verified literal file edits via Cowork/chat turn; consumes usage.',
  design_delete: 'Delete artifact. Requires confirm:true and explicit user request. Background API.',
  design_variants: 'Async artifacts, max 3 concurrent; poll ids with design_check. Require designSystem XOR withoutDesignSystem:true. No preview.',
  design_system_sync: 'Package zip (package.json + styles.css or components/bundle.css) to Design System Cowork/chat; SHA-256 verification. Consumes turns unless precheck skips.',
  design_system_list: 'List account Design Systems. Background API.',
};

const ARTIFACTS_PROPERTIES = {
  account: 'sub only on request.',
  effort: 'low|medium|high|extra|max; default extra; xhigh=extra.',
  model: 'Default opus-5.5.',
};

export function buildTools(backend) {
  if (backend === 'standalone') return STANDALONE_TOOLS;
  return STANDALONE_TOOLS.map((tool) => ({
    ...tool,
    description: ARTIFACTS_DESCRIPTIONS[tool.name],
    inputSchema: { ...tool.inputSchema, properties: Object.fromEntries(
      Object.entries(tool.inputSchema.properties).map(([name, property]) => [name,
        ARTIFACTS_PROPERTIES[name] && (name !== 'model' || property.description)
          ? { ...property, description: ARTIFACTS_PROPERTIES[name] } : property]),
    ) },
  }));
}

// Invalid configuration must not prevent initialize/tools/list; dispatch still rejects it.
export const TOOLS = (() => {
  try { return buildTools(designBackend()); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return buildTools('artifacts');
  }
})();
