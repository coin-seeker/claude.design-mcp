import { decodeToBuffer, sanitizeName } from './helpers.mjs';
import { applyEffortToPage, applyModelToPage, resolveEffort, resolveOptionalModel, withResolvedModel } from './model.mjs';
import { applyDesignSystem, designSystemHook } from './design-system.mjs';
import { checkDesign } from './check.mjs';
import { listDesignSystems } from './list-systems.mjs';
import { previewProject } from './preview.mjs';
import { listAllFiles, listProjects, pullProject, selectProject, deleteProject } from './pull.mjs';
import { omelette } from './rpc.mjs';
import { awaitDesignReady, ensureSession, loginHelp, withOperationPage } from './session.mjs';
import { runDesignSync } from './sync.mjs';
import { runGenerateTurn } from './turn.mjs';
const LOGIN_TIMEOUT_MS = 180_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const schema = (properties, required = []) => ({ type: 'object', properties, required });
export const TOOLS = [
  { name: 'design_login', description: 'Open Chrome for claude.ai/design login and report the active account.', inputSchema: schema({}) },
  { name: 'design_list', description: 'List Claude Design projects from the logged-in web account.', inputSchema: schema({}) },
  { name: 'design_create', description: 'Create a Claude Design project and submit the initial prompt through the composer. With an explicit name, an existing project of that name is reused unless fresh is true. designSystem grounds the design in one of the account design systems from design_system_list.', inputSchema: schema({ prompt: { type: 'string' }, name: { type: 'string' }, wait: { type: 'boolean' }, model: { type: 'string' }, effort: { type: 'string' }, designSystem: { type: 'string' }, fresh: { type: 'boolean' } }, ['prompt']) },
  { name: 'design_iterate', description: 'Submit a follow-up prompt to an existing Claude Design project. designSystem only works while the project has produced no design yet, because claude.ai hides the composer picker afterwards.', inputSchema: schema({ projectId: { type: 'string' }, prompt: { type: 'string' }, wait: { type: 'boolean' }, model: { type: 'string' }, effort: { type: 'string' }, designSystem: { type: 'string' } }, ['projectId', 'prompt']) },
  { name: 'design_pull', description: 'Pull one Claude Design project by projectId or exact name into a local directory.', inputSchema: schema({ projectId: { type: 'string' }, name: { type: 'string' }, dir: { type: 'string' }, zip: { type: 'boolean' } }) },
  { name: 'design_preview', description: 'Render a project\'s self-contained HTML to a full-page PNG screenshot for visual review.', inputSchema: schema({ projectId: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, dir: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }) },
  { name: 'design_get', description: 'Read one file from a Claude Design project.', inputSchema: schema({ projectId: { type: 'string' }, path: { type: 'string' } }, ['projectId', 'path']) },
  { name: 'design_status', description: 'Summarize project data, chat count, and last message role.', inputSchema: schema({ projectId: { type: 'string' } }, ['projectId']) },
  { name: 'design_check', description: 'Poll the completion state of a pending design generation. Returns status: generating | awaiting_input | done | no_output.', inputSchema: schema({ projectId: { type: 'string' } }, ['projectId']) },
  { name: 'design_edit', description: 'Apply direct string edits to one Claude Design project file.', inputSchema: schema({ projectId: { type: 'string' }, path: { type: 'string' }, edits: { type: 'array' } }, ['projectId', 'path', 'edits']) },
  { name: 'design_delete', description: 'Delete one Claude Design project. Only call with confirm:true when the user explicitly asked to delete the project.', inputSchema: schema({ projectId: { type: 'string' }, confirm: { type: 'boolean' } }, ['projectId']) },
  { name: 'design_variants', description: 'Generate multiple design variants of one prompt in parallel (max 3 concurrent), each as its own project, optionally with preview screenshots. designSystem grounds every variant in the same account design system.', inputSchema: schema({ prompt: { type: 'string' }, count: { type: 'number' }, axis: { type: 'string' }, name: { type: 'string' }, preview: { type: 'boolean' }, model: { type: 'string' }, designSystem: { type: 'string' } }, ['prompt']) },
  { name: 'design_system_sync', description: 'Sync a materialized design-system package directory to claude.ai using Claude Code /design-sync. The package must contain package.json and styles.css.', inputSchema: schema({ dir: { type: 'string' } }, ['dir']) },
  { name: 'design_system_list', description: 'List the claude.ai design systems visible to the logged-in account.', inputSchema: schema({}) },
];
function requireString(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}
function derivedName(prompt, name) {
  return sanitizeName(name || String(prompt).replace(/\s+/g, ' ').slice(0, 64));
}
async function design_login() {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const session = await ensureSession({ visible: true, force: true });
      return { loggedIn: true, email: session.me?.email, org: session.org };
    } catch (error) {
      last = error;
      await delay(2_000);
    }
  }
  throw last || new Error(loginHelp('login did not complete before timeout'));
}
async function design_list() {
  const session = await ensureSession({ visible: false });
  return withOperationPage(session, (page) => listProjects({ ...session, page }, { refresh: true }));
}
function recencyKey(project) {
  const value = project?.updatedAt ?? project?.createdAt ?? 0;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

// Reuse an existing project only when the caller pinned an explicit name and did not ask for a fresh one.
// A derived (prompt-based) name stays create-only so repeated prompts never collide with old work.
export async function findOrCreateProject(scoped, name, args = {}, deps = {}) {
  const list = deps.listProjects || listProjects;
  const call = deps.omelette || omelette;
  if (args.name && args.fresh !== true) {
    const projects = await list(scoped, { refresh: true });
    const target = name.normalize('NFC');
    const matches = (Array.isArray(projects) ? projects : []).filter((project) => String(project?.name ?? '').normalize('NFC') === target);
    const found = matches.length > 1 ? [...matches].sort((a, b) => recencyKey(b) - recencyKey(a))[0] : matches[0];
    if (found?.projectId) return { projectId: String(found.projectId), reused: true };
  }
  const created = await call(scoped.page, 'CreateProject', { name, type: 'PROJECT_TYPE_PROJECT' }, scoped.org);
  return { projectId: requireString(created?.projectId, 'projectId'), reused: false };
}

// One injection point for the two composer flows, so a test can drive them without a browser.
const FLOW_DEPS = { ensureSession, withOperationPage, findOrCreateProject, awaitDesignReady, applyModelToPage, applyEffortToPage, applyDesignSystem, runGenerateTurn, listAllFiles };

function withResolvedGeneration(result, selectedModel, selectedEffort) {
  const resolved = withResolvedModel(result, selectedModel);
  return selectedEffort === null ? resolved : { ...resolved, effort: selectedEffort };
}

export async function design_create(args = {}, overrides = {}) {
  const deps = { ...FLOW_DEPS, ...overrides };
  const prompt = requireString(args.prompt, 'prompt');
  const modelRequest = resolveOptionalModel(args.model);
  const effort = resolveEffort(modelRequest, args.effort);
  const session = await deps.ensureSession({ visible: false });
  const name = derivedName(prompt, args.name);
  return deps.withOperationPage(session, async (page) => {
    const scoped = { ...session, page };
    const { projectId, reused } = await deps.findOrCreateProject(scoped, name, args);
    await deps.awaitDesignReady(page, projectId);
    const wait = args.wait !== false;
    const selectedModel = await deps.applyModelToPage(page, modelRequest);
    const selectedEffort = effort === null ? null : await deps.applyEffortToPage(page, effort);
    const attach = designSystemHook(args.designSystem, deps.applyDesignSystem);
    const turn = await deps.runGenerateTurn(scoped, projectId, prompt, { timeoutMs: Number(args.timeoutMs || 360_000), wait, beforeSubmit: attach.hook });
    const result = { projectId, name, url: `https://claude.ai/design/p/${projectId}`, ...turn, ...attach.attached() };
    if (reused) result.reused = true;
    return withResolvedGeneration(wait ? { ...result, files: await deps.listAllFiles(scoped, projectId) } : result, selectedModel, selectedEffort);
  });
}
export async function design_iterate(args = {}, overrides = {}) {
  const deps = { ...FLOW_DEPS, ...overrides };
  const projectId = requireString(args.projectId, 'projectId');
  const prompt = requireString(args.prompt, 'prompt');
  const modelRequest = resolveOptionalModel(args.model);
  const effort = resolveEffort(modelRequest, args.effort);
  const session = await deps.ensureSession({ visible: false });
  return deps.withOperationPage(session, async (page) => {
    const scoped = { ...session, page };
    await deps.awaitDesignReady(page, projectId);
    const wait = args.wait !== false;
    const selectedModel = await deps.applyModelToPage(page, modelRequest);
    const selectedEffort = effort === null ? null : await deps.applyEffortToPage(page, effort);
    const attach = designSystemHook(args.designSystem, deps.applyDesignSystem);
    const turn = await deps.runGenerateTurn(scoped, projectId, prompt, { timeoutMs: Number(args.timeoutMs || 240_000), wait, beforeSubmit: attach.hook });
    const result = { projectId, ...turn, ...attach.attached() };
    return withResolvedGeneration(wait ? { ...result, files: await deps.listAllFiles(scoped, projectId) } : result, selectedModel, selectedEffort);
  });
}
async function design_pull(args = {}) {
  const session = await ensureSession({ visible: false });
  return withOperationPage(session, async (page) => {
    const scoped = { ...session, page };
    const project = selectProject(await listProjects(scoped), { projectId: args.projectId, name: args.name });
    return pullProject(scoped, project.projectId, args.dir, { zip: Boolean(args.zip) });
  });
}
function isText(contentType, filePath) {
  return /^text\//i.test(contentType) || /(?:json|javascript|xml|svg|html|css)$/i.test(contentType) || /\.(?:txt|md|json|js|jsx|ts|tsx|css|html|svg)$/i.test(filePath);
}

async function design_get(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const filePath = requireString(args.path, 'path');
  const session = await ensureSession({ visible: false });
  return withOperationPage(session, async (page) => {
    const file = await omelette(page, 'GetFile', { projectId, path: filePath }, session.org);
    const bytes = decodeToBuffer(file.content || '');
    const contentType = String(file.contentType || 'application/octet-stream');
    if (isText(contentType, filePath)) return { projectId, path: filePath, contentType, version: file.version, text: bytes.toString('utf8') };
    return { projectId, path: filePath, contentType, version: file.version, binary: true, bytes: bytes.length };
  });
}

function parseProjectData(data) {
  if (!data?.data) return {};
  return JSON.parse(decodeToBuffer(data.data).toString('utf8'));
}

async function design_status(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const session = await ensureSession({ visible: false });
  return withOperationPage(session, async (page) => {
    const raw = await omelette(page, 'GetProjectData', { projectId }, session.org);
    const data = parseProjectData(raw);
    const chats = Object.values(data.chats || {});
    const messages = chats.flatMap((chat) => Array.isArray(chat.messages) ? chat.messages : []);
    const last = messages.at(-1) || null;
    return { projectId, chats: chats.length, messages: messages.length, lastMessageRole: last?.role || null };
  });
}

async function design_check(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const session = await ensureSession({ visible: false });
  return withOperationPage(session, (page) => checkDesign({ ...session, page }, projectId));
}

async function design_edit(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const filePath = requireString(args.path, 'path');
  if (!Array.isArray(args.edits)) throw new Error('edits must be an array');
  const session = await ensureSession({ visible: false });
  return withOperationPage(session, (page) => omelette(page, 'EditFile', { projectId, path: filePath, edits: args.edits }, session.org));
}

// Deletion is irreversible, so it stays behind an explicit confirm flag the caller must opt into.
export async function design_delete(args = {}, deps = {}) {
  if (args.confirm !== true) throw new Error('design_delete requires confirm: true. Only call this when the user explicitly asked to delete the project.');
  const openSession = deps.ensureSession || ensureSession;
  const onPage = deps.withOperationPage || withOperationPage;
  const remove = deps.deleteProject || deleteProject;
  const session = await openSession({ visible: false });
  const projectId = requireString(args.projectId, 'projectId');
  return onPage(session, (page) => remove({ ...session, page }, projectId));
}

async function design_preview(args = {}) {
  const session = await ensureSession({ visible: false });
  return withOperationPage(session, async (page) => {
    const scoped = { ...session, page };
    const project = selectProject(await listProjects(scoped), { projectId: args.projectId, name: args.name });
    return previewProject(scoped, project.projectId, { path: args.path, out: args.dir, width: args.width, height: args.height, projectName: project.name });
  });
}

const VARIANTS_MAX_COUNT = 4;
const VARIANTS_MAX_CONCURRENCY = 3;

const AXIS_HINTS = {
  layout: 'Vary the LAYOUT: use a distinctly different page structure, grid, and content arrangement from the other variants.',
  color: 'Vary the COLOR: use a distinctly different color palette and contrast strategy from the other variants.',
  typography: 'Vary the TYPOGRAPHY: use distinctly different typefaces, type scale, and text rhythm from the other variants.',
  mood: 'Vary the MOOD: use a distinctly different overall feel and visual tone from the other variants.',
};

export function variantPrompt(prompt, axis, index, count) {
  const hint = AXIS_HINTS[axis] || (axis ? `Vary along this axis: ${axis}.` : 'Use a clearly different mood, layout, and palette from the other variants.');
  return `${prompt}\n\nThis is variant ${index + 1} of ${count}. ${hint}`;
}

// Minimal semaphore: at most `limit` jobs run at once, the rest queue in FIFO order.
export function createPool(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const run = queue.shift();
    if (run) run();
  };
  return (job) => new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve().then(job).then(resolve, reject).finally(release);
    };
    if (active < limit) run();
    else queue.push(run);
  });
}

export async function design_variants(args = {}, deps = {}) {
  const prompt = requireString(args.prompt, 'prompt');
  const modelRequest = resolveOptionalModel(args.model);
  const model = `${modelRequest.family}${modelRequest.version ? `-${modelRequest.version}` : ''}`;
  const count = Math.max(1, Math.min(VARIANTS_MAX_COUNT, Number(args.count) || 3));
  const axis = args.axis ? String(args.axis) : null;
  const withPreview = args.preview !== false;
  const create = deps.create || design_create;
  const renderPreview = deps.preview || design_preview;
  const acquire = createPool(deps.concurrency || VARIANTS_MAX_CONCURRENCY);
  const baseName = derivedName(prompt, args.name);
  const variants = await Promise.all(Array.from({ length: count }, (_, index) => acquire(async () => {
    try {
      const created = await create({ prompt: variantPrompt(prompt, axis, index, count), name: `${baseName}-v${index + 1}`, timeoutMs: args.timeoutMs, model, designSystem: args.designSystem });
      if (!withPreview) return { index, ...created, image: null };
      try {
        const shot = await renderPreview({ projectId: created.projectId });
        return { index, ...created, image: shot.image || null };
      } catch (error) {
        return { index, ...created, image: null, previewError: String(error?.message || error) };
      }
    } catch (error) {
      return { index, error: String(error?.message || error) };
    }
  })));
  return { prompt, axis, count, variants };
}

// The package directory is produced elsewhere (dashboard materializer); this only runs the sync command in it.
async function design_system_sync(args = {}) {
  return runDesignSync({ dir: requireString(args.dir, 'dir'), timeoutMs: args.timeoutMs });
}

async function design_system_list(_args = {}, deps = {}) {
  return listDesignSystems(deps);
}

export const IMPL = { design_login, design_list, design_create, design_iterate, design_pull, design_preview, design_get, design_status, design_check, design_edit, design_delete, design_variants, design_system_sync, design_system_list };
