import { omelette } from './rpc.mjs';
import { ensureSession, withOperationPage } from './session.mjs';

export function isTextProjectFile(contentType, filePath) {
  return /^text\//i.test(contentType) || /(?:json|javascript|xml|svg|html|css)$/i.test(contentType) || /\.(?:txt|md|json|js|jsx|ts|tsx|css|html|svg)$/i.test(filePath);
}

export async function getProjectFile(scoped, projectId, filePath, call = omelette) {
  return call(scoped.page, 'GetFile', { projectId, path: filePath }, scoped.org);
}

export async function editProjectFile(scoped, projectId, filePath, edits, call = omelette) {
  return call(scoped.page, 'EditFile', { projectId, path: filePath, edits }, scoped.org);
}

export async function writeProjectTextFile({ projectId, path: filePath, content }, deps = {}) {
  const openSession = deps.ensureSession || ensureSession;
  const onPage = deps.withOperationPage || withOperationPage;
  const call = deps.omelette || omelette;
  const session = await openSession({ visible: false });
  return onPage(session, (page) => call(page, 'WriteFiles', {
    projectId,
    files: [{ path: filePath, data: content, encoding: '', mimeType: 'text/css' }],
    deletePaths: [],
    deduplicate: false,
  }, session.org));
}
