import path from 'node:path';
import { currentAccount } from '../accounts.mjs';
import { ensureSession } from '../session.mjs';
import { withOperationPage, withRpcPage } from '../operation-pages.mjs';
import { resolveOptionalModel, resolveEffort } from '../model.mjs';
import { frameRequest, frameFileUrl, ccrRequest } from './api.mjs';
import { getManifest, projectFiles, artifactSignature, fetchFileBytes } from './manifest.mjs';
import { artifactsSystemList } from './read-tools.mjs';
import { updateEntry, removeEntry, readIndex } from './index-store.mjs';
import { artifactUrl } from './listing.mjs';
import { readAllEvents, isRealPrompt, EMPTY_SIGNATURE } from './turn.mjs';
import { confirmSubmitted } from './generate.mjs';
import { waitForArtifactTurn } from './generation-wait.mjs';
import { readPackage, zipPackage, verbatimFiles, buildSyncPrompt, verifySync, syncPromptOptions, BUNDLE_LIBRARIES } from './ds-package.mjs';
import { openNewDesignSystem, openDesignSystemChat, waitForInput, applyModelArtifacts, applyEffortArtifacts, attachFile, sendPrompt } from './composer.mjs';
import { artifactIdFromUrl } from './surface.mjs';
import { readChatMessages, chatPromptCount, findWorkspaceSessionId } from './chat-turn.mjs';

const SYNC_DEPS = {
  ensureSession, withOperationPage, withRpcPage, frameRequest, ccrRequest, getManifest, projectFiles, artifactSignature,
  fetchFileBytes, artifactsSystemList, updateEntry, removeEntry, readIndex, readAllEvents, readChatMessages, findWorkspaceSessionId, confirmSubmitted, waitForArtifactTurn,
  readPackage, zipPackage, verbatimFiles, buildSyncPrompt, verifySync, openNewDesignSystem, openDesignSystemChat,
  waitForInput, applyModelArtifacts, applyEffortArtifacts, attachFile, sendPrompt, now: Date.now,
};

export async function artifactsSystemSync(args = {}, overrides = {}) {
  const deps = { ...SYNC_DEPS, ...overrides };
  let result = { ok: false, dir: args.dir ?? null, backend: 'artifacts', account: currentAccount(), skipped: false, systemName: null, artifactId: null,
    projectId: null, sessionId: null, url: null, created: false, verified: { files: 0, mismatched: [] } };
  let archive;
  // This public boundary converts every sync failure into the result contract, including cleanup.
  try {
    const progress = (text) => args.onProgress?.(text);
    progress('Reading design-system package');
    const pkg = await deps.readPackage(args.dir);
    result = { ...result, dir: pkg.dir, systemName: pkg.title };
    const request = resolveOptionalModel(args.model);
    const effort = resolveEffort(request, args.effort);
    const timeoutMs = Number(args.timeoutMs ?? 900_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    const session = await deps.ensureSession({ visible: false });
    progress('Resolving Design System artifact');
    const systems = await deps.artifactsSystemList({}, { ...deps, ensureSession: async () => session });
    let target = pkg.artifactId && systems.find((item) => item.id === pkg.artifactId);
    if (!target) {
      const matches = systems.filter((item) => item.name === pkg.title);
      if (matches.length > 1) throw new Error(`ambiguous Design System title: ${pkg.title}`);
      target = matches[0];
    }
    const title = target ? target.name : pkg.title;
    result = { ...result, systemName: title, created: !target,
      artifactId: target?.id ?? null, projectId: target?.id ?? null };
    const verifyPublished = async (scoped, projectId) => {
      const manifest = await deps.getManifest(scoped, projectId, deps);
      const files = deps.projectFiles(manifest.files).map(({ rel, ...file }) => file);
      const readJson = async (filePath) => {
        const bytes = await deps.fetchFileBytes(frameFileUrl(projectId, manifest.ver, filePath, manifest.assetToken), deps.fetchImpl);
        try { return JSON.parse(bytes.toString('utf8')); }
        catch (error) {
          if (error instanceof SyntaxError) return null;
          throw error;
        }
      };
      let index;
      const verified = await deps.verifySync(files, pkg, title, async () => {
        index = await readJson('project/design-system.json');
        return index?.title;
      }, () => readJson('project/tokens.json'));
      const bundleMismatch = pkg.bundle && (index?.namespace !== pkg.bundle.namespace
        || !BUNDLE_LIBRARIES.every((lib) => index?.libraries?.some?.((item) => item?.name === lib.name && String(item?.version).startsWith(lib.version))));
      if (index && (Object.hasOwn(index, 'editing') || Object.hasOwn(index, 'source') || bundleMismatch)
        && !verified.mismatched.includes('project/design-system.json')) verified.mismatched.push('project/design-system.json');
      return { manifest, verified };
    };
    if (target) {
      const { verified } = await deps.withRpcPage(session, (page) => verifyPublished({ ...session, page }, target.id));
      if (!verified.mismatched.length) {
        const entry = deps.readIndex().byArtifact[target.id];
        deps.updateEntry(target.id, { name: title });
        const skipped = { ...result, ok: true, skipped: true, created: false, verified, url: artifactUrl(target.id, null, entry?.chatId) };
        if (entry?.surface === 'chat') delete skipped.sessionId;
        return skipped;
      }
    }
    archive = await deps.zipPackage(pkg);
    result = await deps.withOperationPage(session, async (page) => {
      const scoped = { ...session, page };
      let opened;
      let sent = false;
      try {
        progress(target ? 'Opening Design System chat' : 'Creating Design System artifact');
        opened = target ? await deps.openDesignSystemChat(page, target.id) : await deps.openNewDesignSystem(page);
        const { projectId, sessionId } = opened;
        result = { ...result, artifactId: projectId, projectId, sessionId, url: artifactUrl(projectId, sessionId, opened.chatId) };
        if (opened.surface === 'chat') delete result.sessionId;
        if (!target) await deps.frameRequest(scoped, 'POST', `/api/frame/retitle/${encodeURIComponent(projectId)}`, { title });
        await deps.waitForInput(page);
        await deps.applyModelArtifacts(page, request);
        await deps.applyEffortArtifacts(page, effort);
        progress('Attaching design-system package');
        await deps.attachFile(page, archive.path, path.basename(archive.path));
        let baseline = target ? deps.artifactSignature((await deps.getManifest(scoped, projectId, deps)).files) : EMPTY_SIGNATURE;
        let prompt = deps.buildSyncPrompt({ title, created: !target, verbatim: deps.verbatimFiles(pkg), ...syncPromptOptions(pkg) });
        for (let attempt = 0; attempt < 2; attempt++) {
          const before = opened.surface === 'chat' ? chatPromptCount(await deps.readChatMessages(scoped, opened.chatId, deps))
            : (await deps.readAllEvents(scoped, sessionId, deps)).filter(isRealPrompt).length;
          progress(attempt ? 'Submitting one corrective sync turn' : 'Submitting design-system sync turn');
          await deps.sendPrompt(page, prompt);
          sent = true;
          await deps.confirmSubmitted(scoped, opened.surface === 'chat' ? opened : sessionId, before, deps);
          const workspaceSessionId = opened.surface === 'chat'
            ? await deps.findWorkspaceSessionId(scoped, opened.chatId, deps).catch(() => null) : null;
          deps.updateEntry(projectId, { name: title, sessionId, ...(opened.surface ? { surface: opened.surface, chatId: opened.chatId } : {}), ...(workspaceSessionId ? { workspaceSessionId } : {}), lastSubmitSignature: baseline,
            submittedAt: new Date(deps.now()).toISOString(), promptCountAtSubmit: before + 1 });
          const settled = await deps.waitForArtifactTurn(scoped, { ...opened, baseline, timeoutMs }, deps);
          result = { ...result, status: settled.status,
            ...(opened.surface !== 'chat' && typeof settled.costUsd === 'number' ? { costUsd: (result.costUsd ?? 0) + settled.costUsd } : {}) };
          if (settled.status !== 'done') return { ...result, error: `Design System sync did not finish: ${settled.status}` };
          progress('Verifying published design-system files');
          const { manifest, verified } = await verifyPublished(scoped, projectId);
          result = { ...result, verified };
          if (!verified.mismatched.length) return { ...result, ok: true };
          baseline = deps.artifactSignature(manifest.files);
          prompt = `Correct the previous sync. Verification failed for these paths:\n${verified.mismatched.map((file) => `- ${file}`).join('\n')}\n${deps.buildSyncPrompt({ title, created: false, verbatim: deps.verbatimFiles(pkg), ...syncPromptOptions(pkg) })}`;
        }
        return { ...result, error: `Design System verification failed: ${result.verified.mismatched.join(', ')}` };
      } catch (error) {
        const projectId = opened?.projectId ?? artifactIdFromUrl(page.url?.());
        if (!target && projectId && !sent) {
          await deps.frameRequest(scoped, 'DELETE', `/api/frame/${encodeURIComponent(projectId)}`).catch(() => {});
          if (opened?.sessionId) await deps.ccrRequest(scoped, `/v1/code/sessions/${encodeURIComponent(opened.sessionId)}`, 'DELETE').catch(() => {});
          try { deps.removeEntry(projectId); } catch { /* Preserve the sync failure if local cleanup fails. */ }
        }
        throw error;
      }
    });
  } catch (error) {
    result = { ...result, ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (archive) {
      try { await archive.cleanup(); }
      catch (error) { result = { ...result, ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
  }
  return result;
}
