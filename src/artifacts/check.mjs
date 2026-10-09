import { ensureSession } from '../session.mjs';
import { withRpcPage } from '../operation-pages.mjs';
import { ccrRequest } from './api.mjs';
import { readIndex } from './index-store.mjs';
import { classifyArtifactTurn, readAllEvents } from './turn.mjs';
import { readChatMessages, classifyChatTurn } from './chat-turn.mjs';

export { readAllEvents } from './turn.mjs';

// Lazy imports keep classifier/check tests independent of the concurrent T3 work.
const CHECK_DEPS = {
  ensureSession,
  withRpcPage,
  ccrRequest,
  readIndex,
  readAllEvents,
  readChatMessages,
  resolveSessionId: async (scoped, id) => (await import('./listing.mjs')).resolveSessionId(scoped, id),
  readManifest: async (scoped, id) => (await import('./manifest.mjs')).getManifest(scoped, id),
  signature: async (files) => (await import('./manifest.mjs')).artifactSignature(files),
  now: Date.now,
};

export async function artifactsCheck(args = {}, overrides = {}) {
  const deps = { ...CHECK_DEPS, ...overrides };
  const projectId = String(args.projectId ?? '').trim();
  if (!projectId) throw new Error('projectId is required');
  const session = await deps.ensureSession({ visible: false });
  return deps.withRpcPage(session, async (page) => {
    const scoped = { ...session, page };
    const indexed = deps.readIndex().byArtifact[projectId];
    if (indexed?.surface === 'chat' && indexed.chatId) {
      const [messages, manifest] = await Promise.all([
        deps.readChatMessages(scoped, indexed.chatId, deps), deps.readManifest(scoped, projectId),
      ]);
      const signature = await deps.signature(manifest.files);
      const turn = classifyChatTurn({ messages, signature, submitSignature: indexed.lastSubmitSignature, now: deps.now(), ...(deps.chatStallMs === undefined ? {} : { stallMs: deps.chatStallMs }) });
      return {
        projectId, backend: 'artifacts', ...turn,
        files: manifest.files.filter(({ path }) => path.startsWith('project/'))
          .map(({ path, size, sha256 }) => ({ path: path.slice('project/'.length), size, sha256 })),
        answeredQuestions: false, checkPath: 'artifacts', signature,
        remoteUpdatedAt: new Date(manifest.updatedAt).toISOString(),
      };
    }
    const sessionId = await deps.resolveSessionId(scoped, projectId);
    if (!sessionId) throw new Error(`no Cowork session found for artifact ${projectId}`);
    const [state, events, manifest] = await Promise.all([
      deps.ccrRequest(scoped, `/v1/code/sessions/${encodeURIComponent(sessionId)}`),
      deps.readAllEvents(scoped, sessionId, { ccrRequest: deps.ccrRequest }),
      deps.readManifest(scoped, projectId),
    ]);
    const signature = await deps.signature(manifest.files);
    const entry = deps.readIndex().byArtifact[projectId];
    const turn = classifyArtifactTurn({
      session: state, events, signature, submitSignature: entry?.lastSubmitSignature,
      now: deps.now(), stallMs: deps.stallMs,
    });
    return {
      projectId, sessionId, backend: 'artifacts', ...turn,
      files: manifest.files.filter(({ path }) => path.startsWith('project/'))
        .map(({ path, size, sha256 }) => ({ path: path.slice('project/'.length), size, sha256 })),
      answeredQuestions: false, checkPath: 'artifacts', signature,
      remoteUpdatedAt: new Date(manifest.updatedAt).toISOString(),
    };
  });
}
