import { ensureSession } from '../session.mjs';
import { withOperationPage, withRpcPage } from '../operation-pages.mjs';
import { sanitizeName } from '../helpers.mjs';
import { assertDesignSystemChoice, designSystemChoiceEcho } from '../design-system.mjs';
import { resolveOptionalModel, resolveEffort } from '../model.mjs';
import { generateVariants } from '../variants.mjs';
import { frameRequest, ccrRequest, ArtifactsHttpError } from './api.mjs';
import { findByName, updateEntry, removeEntry } from './index-store.mjs';
import { resolveDesign, resolveSessionId, artifactUrl } from './listing.mjs';
import { getManifest, artifactSignature } from './manifest.mjs';
import { readAllEvents, isRealPrompt, EMPTY_SIGNATURE } from './turn.mjs';
import * as composer from './composer.mjs';
import { confirmSubmitted, holdUntilSettled, waitForArtifactTurn } from './generation-wait.mjs';

export { confirmSubmitted, holdUntilSettled } from './generation-wait.mjs';
export { artifactsEdit } from './edit.mjs';

const FLOW_DEPS = {
  ensureSession, withOperationPage, withRpcPage, frameRequest, ccrRequest,
  findByName, updateEntry, removeEntry, resolveDesign, resolveSessionId, getManifest, artifactSignature,
  readAllEvents, ...composer, confirmSubmitted, holdUntilSettled, waitForArtifactTurn, now: Date.now,
  artifactsIterate,
};

function requireString(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

async function finishTurn(page, scoped, turn, deps) {
  const result = { projectId: turn.projectId, url: artifactUrl(turn.projectId, turn.sessionId), sessionId: turn.sessionId, backend: 'artifacts', model: turn.model, effort: turn.effort, ...turn.echo };
  if (!turn.wait) {
    deps.holdUntilSettled(page, scoped, turn.projectId, deps);
    return { ...result, submitted: true, pending: true };
  }
  const settled = await deps.waitForArtifactTurn(scoped, turn, deps);
  if (settled.timedOut) deps.holdUntilSettled(page, scoped, turn.projectId, deps);
  return { ...result, ...settled };
}

export async function artifactsCreate(args = {}, overrides = {}) {
  const choice = assertDesignSystemChoice(args);
  const deps = { ...FLOW_DEPS, ...overrides };
  const prompt = requireString(args.prompt, 'prompt');
  const request = resolveOptionalModel(args.model);
  const effort = resolveEffort(request, args.effort);
  const name = sanitizeName(args.name || prompt.replace(/\s+/g, ' ').slice(0, 64));
  const session = await deps.ensureSession({ visible: false });
  if (args.name && args.fresh !== true) {
    let existing = deps.findByName(name);
    if (!existing) {
      existing = await deps.withRpcPage(session, async (page) => {
        try { return await deps.resolveDesign({ ...session, page }, { name }, deps); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== `remote project not found by name: ${name}`) throw error;
          return null;
        }
      });
    }
    if (existing) {
      const result = await deps.artifactsIterate({ projectId: existing.projectId, prompt, model: args.model, effort, wait: args.wait, timeoutMs: args.timeoutMs, ...(choice.designSystem ? { designSystem: choice.designSystem } : {}) }, deps);
      return { ...result, ...designSystemChoiceEcho(choice), name, reused: true };
    }
  }
  return deps.withOperationPage(session, async (page) => {
    const scoped = { ...session, page };
    let created;
    let sent = false;
    try {
      created = await deps.openNewDesign(page);
      const { projectId, sessionId } = created;
      await deps.frameRequest(scoped, 'POST', `/api/frame/retitle/${encodeURIComponent(projectId)}`, { title: name });
      deps.updateEntry(projectId, { name, sessionId });
      await deps.waitForInput(page);
      const model = await deps.applyModelArtifacts(page, request);
      const selectedEffort = await deps.applyEffortArtifacts(page, effort);
      const system = await deps.applyDesignSystemArtifacts(page, choice.designSystem ?? null);
      let baseline;
      try { baseline = deps.artifactSignature((await deps.getManifest(scoped, projectId, deps)).files); }
      catch (error) {
        // Only a genuinely not-yet-published empty artifact may lack a manifest.
        if (!(error instanceof ArtifactsHttpError) || error.status !== 404) throw error;
        baseline = EMPTY_SIGNATURE;
      }
      await deps.sendPrompt(page, prompt);
      sent = true;
      await deps.confirmSubmitted(scoped, sessionId, 0, deps);
      deps.updateEntry(projectId, { lastSubmitSignature: baseline, submittedAt: new Date(deps.now()).toISOString(), promptCountAtSubmit: 1 });
      const echo = system.name ? { designSystem: system.name } : designSystemChoiceEcho(choice);
      const result = await finishTurn(page, scoped, { ...created, model: model.apiId, effort: selectedEffort, echo, baseline, wait: args.wait !== false, timeoutMs: Number(args.timeoutMs ?? 360_000) }, deps);
      return { ...result, name };
    } catch (error) {
      if (created && !sent) {
        await deps.frameRequest(scoped, 'DELETE', `/api/frame/${encodeURIComponent(created.projectId)}`).catch(() => {});
        try { deps.removeEntry(created.projectId); } catch { /* Preserve the original failure on cleanup errors. */ }
      }
      throw error;
    }
  });
}

export async function artifactsIterate(args = {}, overrides = {}) {
  const deps = { ...FLOW_DEPS, ...overrides };
  const projectId = requireString(args.projectId, 'projectId');
  const prompt = requireString(args.prompt, 'prompt');
  const request = resolveOptionalModel(args.model);
  const effort = resolveEffort(request, args.effort);
  const session = await deps.ensureSession({ visible: false });
  const sessionId = await deps.withRpcPage(session, async (page) => {
    const scoped = { ...session, page };
    const id = await deps.resolveSessionId(scoped, projectId, deps);
    if (!id) throw new Error(`no Cowork session found for artifact ${projectId}`);
    const state = await deps.ccrRequest(scoped, `/v1/code/sessions/${encodeURIComponent(id)}`);
    if (state.worker_status !== 'idle') throw new Error(`a turn is still running on ${projectId}; poll design_check first`);
    return id;
  });
  return deps.withOperationPage(session, async (page) => {
    const scoped = { ...session, page };
    await deps.openDesignSession(page, sessionId, projectId);
    const model = await deps.applyModelArtifacts(page, request);
    const selectedEffort = await deps.applyEffortArtifacts(page, effort);
    let echo = {};
    if (args.designSystem !== undefined && args.designSystem !== null) {
      if (!(await deps.pickerState(page)).visible) throw new Error(composer.PICKER_MISSING);
      echo = { designSystem: (await deps.applyDesignSystemArtifacts(page, args.designSystem)).name };
    }
    const baseline = deps.artifactSignature((await deps.getManifest(scoped, projectId, deps)).files);
    const before = (await deps.readAllEvents(scoped, sessionId, deps)).filter(isRealPrompt).length;
    await deps.sendPrompt(page, prompt);
    await deps.confirmSubmitted(scoped, sessionId, before, deps);
    deps.updateEntry(projectId, { sessionId, lastSubmitSignature: baseline, submittedAt: new Date(deps.now()).toISOString(), promptCountAtSubmit: before + 1 });
    return finishTurn(page, scoped, { projectId, sessionId, model: model.apiId, effort: selectedEffort, echo, baseline, wait: args.wait !== false, timeoutMs: Number(args.timeoutMs ?? 240_000) }, deps);
  });
}

export async function artifactsVariants(args = {}, overrides = {}) {
  assertDesignSystemChoice(args);
  const create = overrides.artifactsCreate ?? artifactsCreate;
  const preview = overrides.artifactsPreview ?? (async (input) => (await import('./preview.mjs')).artifactsPreview(input, overrides));
  return generateVariants(args, { create: (input) => create(input, overrides), preview, concurrency: overrides.concurrency });
}
