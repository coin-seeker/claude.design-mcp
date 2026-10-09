import path from 'node:path';
import { ensureSession } from '../session.mjs';
import { withOperationPage, withRpcPage } from '../operation-pages.mjs';
import { resolveOptionalModel, resolveEffort } from '../model.mjs';
import { frameRequest, frameFileUrl } from './api.mjs';
import { getManifest, projectFiles, artifactSignature, fetchFileBytes } from './manifest.mjs';
import { artifactsSystemList } from './read-tools.mjs';
import { updateEntry } from './index-store.mjs';
import { artifactUrl } from './listing.mjs';
import { readAllEvents, isRealPrompt, EMPTY_SIGNATURE } from './turn.mjs';
import { confirmSubmitted } from './generate.mjs';
import { waitForArtifactTurn } from './generation-wait.mjs';
import { readPackage, zipPackage, verbatimFiles, buildSyncPrompt, verifySync } from './ds-package.mjs';
import { openNewDesignSystem, openDesignSystemChat, waitForInput, applyModelArtifacts, applyEffortArtifacts, attachFile, sendPrompt } from './composer.mjs';

const SYNC_DEPS = {
  ensureSession, withOperationPage, withRpcPage, frameRequest, getManifest, projectFiles, artifactSignature,
  fetchFileBytes, artifactsSystemList, updateEntry, readAllEvents, confirmSubmitted, waitForArtifactTurn,
  readPackage, zipPackage, verbatimFiles, buildSyncPrompt, verifySync, openNewDesignSystem, openDesignSystemChat,
  waitForInput, applyModelArtifacts, applyEffortArtifacts, attachFile, sendPrompt, now: Date.now,
};

export async function artifactsSystemSync(args = {}, overrides = {}) {
  const deps = { ...SYNC_DEPS, ...overrides };
  let result = { ok: false, dir: args.dir ?? null, backend: 'artifacts', systemName: null, artifactId: null,
    projectId: null, sessionId: null, url: null, created: false, verified: { files: 0, mismatched: [] } };
  let archive;
  // This public boundary converts every sync failure into the result contract, including cleanup.
  try {
    const progress = (text) => args.onProgress?.(text);
    progress('Reading design-system package');
    const pkg = await deps.readPackage(args.dir);
    result = { ...result, dir: pkg.dir, systemName: pkg.title };
    const request = resolveOptionalModel(args.model ?? 'sonnet');
    const effort = resolveEffort(request, args.effort ?? 'medium');
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
    archive = await deps.zipPackage(pkg);
    result = await deps.withOperationPage(session, async (page) => {
      const scoped = { ...session, page };
      progress(target ? 'Opening Design System chat' : 'Creating Design System artifact');
      const opened = target ? await deps.openDesignSystemChat(page, target.id) : await deps.openNewDesignSystem(page);
      const { projectId, sessionId } = opened;
      result = { ...result, artifactId: projectId, projectId, sessionId, url: artifactUrl(projectId, sessionId) };
      if (!target) await deps.frameRequest(scoped, 'POST', `/api/frame/retitle/${encodeURIComponent(projectId)}`, { title });
      await deps.waitForInput(page);
      await deps.applyModelArtifacts(page, request);
      await deps.applyEffortArtifacts(page, effort);
      progress('Attaching design-system package');
      await deps.attachFile(page, archive.path, path.basename(archive.path));
      let baseline = target ? deps.artifactSignature((await deps.getManifest(scoped, projectId, deps)).files) : EMPTY_SIGNATURE;
      let prompt = deps.buildSyncPrompt({ title, created: !target, verbatim: deps.verbatimFiles(pkg) });
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = (await deps.readAllEvents(scoped, sessionId, deps)).filter(isRealPrompt).length;
        progress(attempt ? 'Submitting one corrective sync turn' : 'Submitting design-system sync turn');
        await deps.sendPrompt(page, prompt);
        await deps.confirmSubmitted(scoped, sessionId, before, deps);
        deps.updateEntry(projectId, { name: title, sessionId, lastSubmitSignature: baseline,
          submittedAt: new Date(deps.now()).toISOString(), promptCountAtSubmit: before + 1 });
        const settled = await deps.waitForArtifactTurn(scoped, { projectId, sessionId, baseline, timeoutMs }, deps);
        result = { ...result, status: settled.status,
          ...(typeof settled.costUsd === 'number' ? { costUsd: (result.costUsd ?? 0) + settled.costUsd } : {}) };
        if (settled.status !== 'done') return { ...result, error: `Design System sync did not finish: ${settled.status}` };
        progress('Verifying published design-system files');
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
        if (index && (Object.hasOwn(index, 'editing') || Object.hasOwn(index, 'source'))
          && !verified.mismatched.includes('project/design-system.json')) verified.mismatched.push('project/design-system.json');
        result = { ...result, verified };
        if (!verified.mismatched.length) return { ...result, ok: true };
        baseline = deps.artifactSignature(manifest.files);
        prompt = `Correct the previous sync. Verification failed for these paths:\n${verified.mismatched.map((file) => `- ${file}`).join('\n')}\n${deps.buildSyncPrompt({ title, created: false, verbatim: deps.verbatimFiles(pkg) })}`;
      }
      return { ...result, error: `Design System verification failed: ${result.verified.mismatched.join(', ')}` };
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
