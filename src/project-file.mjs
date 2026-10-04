import { decodeToBuffer } from './helpers.mjs';
import { omelette } from './rpc.mjs';
import { ensureSession, withRpcPage } from './session.mjs';

export function isTextProjectFile(contentType, filePath) {
  return /^text\//i.test(contentType) || /(?:json|javascript|xml|svg|html|css)$/i.test(contentType) || /\.(?:txt|md|json|js|jsx|ts|tsx|css|html|svg)$/i.test(filePath);
}

export async function getProjectFile(scoped, projectId, filePath, call = omelette) {
  return call(scoped.page, 'GetFile', { projectId, path: filePath }, scoped.org);
}

export async function editProjectFile(scoped, projectId, filePath, edits, call = omelette) {
  return call(scoped.page, 'EditFile', { projectId, path: filePath, edits }, scoped.org);
}

// GetFile answers a missing path with empty content rather than an error, so callers
// must treat '' as "absent", not as a successful read of an empty file.
export async function readProjectTextFile({ projectId, path: filePath }, deps = {}) {
  const openSession = deps.ensureSession || ensureSession;
  const onPage = deps.withRpcPage || withRpcPage;
  const call = deps.omelette || omelette;
  const session = await openSession({ visible: false });
  const file = await onPage(session, (page) => call(page, 'GetFile', { projectId, path: filePath }, session.org));
  return decodeToBuffer(file?.content || '').toString('utf8');
}

export async function writeProjectTextFile({ projectId, path: filePath, content }, deps = {}) {
  const openSession = deps.ensureSession || ensureSession;
  const onPage = deps.withRpcPage || withRpcPage;
  const call = deps.omelette || omelette;
  const session = await openSession({ visible: false });
  return onPage(session, (page) => call(page, 'WriteFiles', {
    projectId,
    files: [{ path: filePath, data: content, encoding: '', mimeType: 'text/css' }],
    deletePaths: [],
    deduplicate: false,
  }, session.org));
}
