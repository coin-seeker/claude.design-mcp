import { decodeToBuffer, sanitizeName } from './helpers.mjs';
import { listAllFiles, listProjects, pullProject, selectProject, deleteProject } from './pull.mjs';
import { omelette } from './rpc.mjs';
import { awaitDesignReady, ensureSession, loginHelp } from './session.mjs';
import { runGenerateTurn } from './turn.mjs';

const LOGIN_TIMEOUT_MS = 180_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const schema = (properties, required = []) => ({ type: 'object', properties, required });

export const TOOLS = [
  { name: 'design_login', description: 'Open Chrome for claude.ai/design login and report the active account.', inputSchema: schema({}) },
  { name: 'design_list', description: 'List Claude Design projects from the logged-in web account.', inputSchema: schema({}) },
  { name: 'design_create', description: 'Create a Claude Design project and submit the initial prompt through the composer.', inputSchema: schema({ prompt: { type: 'string' }, name: { type: 'string' } }, ['prompt']) },
  { name: 'design_iterate', description: 'Submit a follow-up prompt to an existing Claude Design project.', inputSchema: schema({ projectId: { type: 'string' }, prompt: { type: 'string' } }, ['projectId', 'prompt']) },
  { name: 'design_pull', description: 'Pull one Claude Design project by projectId or exact name into a local directory.', inputSchema: schema({ projectId: { type: 'string' }, name: { type: 'string' }, dir: { type: 'string' }, zip: { type: 'boolean' } }) },
  { name: 'design_get', description: 'Read one file from a Claude Design project.', inputSchema: schema({ projectId: { type: 'string' }, path: { type: 'string' } }, ['projectId', 'path']) },
  { name: 'design_status', description: 'Summarize project data, chat count, and last message role.', inputSchema: schema({ projectId: { type: 'string' } }, ['projectId']) },
  { name: 'design_edit', description: 'Apply direct string edits to one Claude Design project file.', inputSchema: schema({ projectId: { type: 'string' }, path: { type: 'string' }, edits: { type: 'array' } }, ['projectId', 'path', 'edits']) },
  { name: 'design_delete', description: 'Delete one Claude Design project.', inputSchema: schema({ projectId: { type: 'string' } }, ['projectId']) },
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
  return listProjects(await ensureSession({ visible: false }), { refresh: true });
}

async function design_create(args = {}) {
  const prompt = requireString(args.prompt, 'prompt');
  const session = await ensureSession({ visible: false });
  const name = derivedName(prompt, args.name);
  const created = await omelette(session.page, 'CreateProject', { name, type: 'PROJECT_TYPE_PROJECT' }, session.org);
  const projectId = requireString(created.projectId, 'projectId');
  await awaitDesignReady(session.page, projectId);
  const turn = await runGenerateTurn(session, projectId, prompt, { timeoutMs: Number(args.timeoutMs || 300_000) });
  return { projectId, name, url: `https://claude.ai/design/p/${projectId}`, ...turn, files: await listAllFiles(session, projectId) };
}

async function design_iterate(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const prompt = requireString(args.prompt, 'prompt');
  const session = await ensureSession({ visible: false });
  await awaitDesignReady(session.page, projectId);
  const turn = await runGenerateTurn(session, projectId, prompt, { timeoutMs: Number(args.timeoutMs || 240_000) });
  return { projectId, ...turn, files: await listAllFiles(session, projectId) };
}

async function design_pull(args = {}) {
  const session = await ensureSession({ visible: false });
  const project = selectProject(await listProjects(session), { projectId: args.projectId, name: args.name });
  return pullProject(session, project.projectId, args.dir, { zip: Boolean(args.zip) });
}

function isText(contentType, filePath) {
  return /^text\//i.test(contentType) || /(?:json|javascript|xml|svg|html|css)$/i.test(contentType) || /\.(?:txt|md|json|js|jsx|ts|tsx|css|html|svg)$/i.test(filePath);
}

async function design_get(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const filePath = requireString(args.path, 'path');
  const session = await ensureSession({ visible: false });
  const file = await omelette(session.page, 'GetFile', { projectId, path: filePath }, session.org);
  const bytes = decodeToBuffer(file.content || '');
  const contentType = String(file.contentType || 'application/octet-stream');
  if (isText(contentType, filePath)) return { projectId, path: filePath, contentType, version: file.version, text: bytes.toString('utf8') };
  return { projectId, path: filePath, contentType, version: file.version, binary: true, bytes: bytes.length };
}

function parseProjectData(data) {
  if (!data?.data) return {};
  return JSON.parse(decodeToBuffer(data.data).toString('utf8'));
}

async function design_status(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const session = await ensureSession({ visible: false });
  const raw = await omelette(session.page, 'GetProjectData', { projectId }, session.org);
  const data = parseProjectData(raw);
  const chats = Object.values(data.chats || {});
  const messages = chats.flatMap((chat) => Array.isArray(chat.messages) ? chat.messages : []);
  const last = messages.at(-1) || null;
  return { projectId, chats: chats.length, messages: messages.length, lastMessageRole: last?.role || null };
}

async function design_edit(args = {}) {
  const projectId = requireString(args.projectId, 'projectId');
  const filePath = requireString(args.path, 'path');
  if (!Array.isArray(args.edits)) throw new Error('edits must be an array');
  const session = await ensureSession({ visible: false });
  return omelette(session.page, 'EditFile', { projectId, path: filePath, edits: args.edits }, session.org);
}

async function design_delete(args = {}) {
  const session = await ensureSession({ visible: false });
  return deleteProject(session, requireString(args.projectId, 'projectId'));
}

export const IMPL = { design_login, design_list, design_create, design_iterate, design_pull, design_get, design_status, design_edit, design_delete };
