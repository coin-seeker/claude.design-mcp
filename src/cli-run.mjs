import { parseCreateFlags, parseGenerateFlags, parseListFlags, parseSyncFlags } from './cli.mjs';
import { normalizeCaller } from './history.mjs';
import { resolveAccountFor } from './account-routing.mjs';
import { resolveAccount, withAccount } from './accounts.mjs';
import { designBackend } from './backend.mjs';
import { runDesignSync } from './sync.mjs';

const RECORDED_COMMANDS = {
  create: 'design_create', iterate: 'design_iterate', check: 'design_check',
  pull: 'design_pull', sync: 'design_system_sync', history: 'design_history',
};

function callerFromEnv(env) {
  try {
    return normalizeCaller(JSON.parse(env.CLAUDE_DESIGN_CALLER || 'null')) ?? { agent: 'cli' };
  } catch (error) {
    if (error instanceof SyntaxError) return { agent: 'cli' };
    throw error;
  }
}

function pullCliArgs(rest) {
  const zip = rest.includes('--zip');
  const args = rest.filter((arg) => arg !== '--zip');
  const target = args[0];
  const key = /^[0-9a-f-]{20,}$/i.test(target || '') ? 'projectId' : 'name';
  return { [key]: target, dir: args[1], zip };
}

function previewCliArgs(rest) {
  const target = rest[0];
  const key = /^[0-9a-f-]{20,}$/i.test(target || '') ? 'projectId' : 'name';
  return { [key]: target, dir: rest[1], width: rest[2] ? Number(rest[2]) : undefined };
}

// Transport-free dispatch; send is optional and streams sync progress before completion.
// Operation errors propagate to the server's existing stderr/process-exit boundary.
export async function runCliCommand(argv, deps) {
  const { IMPL, recordToolCall, snapshotForToolCall, env = process.env, send } = deps;
  const [cmd, ...rest] = argv;
  const tool = Object.hasOwn(RECORDED_COMMANDS, cmd) ? RECORDED_COMMANDS[cmd] : null;
  const recording = tool !== null && env.CLAUDE_DESIGN_CLI_HISTORY !== '0';
  const caller = recording ? callerFromEnv(env) : null;
  const stdoutLines = [];
  const startedAt = Date.now();
  let args = {}, result, error, account = null;
  try {
    let dispatchTool;
    switch (cmd) {
      case 'login': dispatchTool = 'design_login'; break;
      case 'list': dispatchTool = 'design_list'; args = parseListFlags(rest).flags; break;
      case 'list-systems': dispatchTool = 'design_system_list'; break;
      case 'create': {
        const { positional, flags } = parseCreateFlags(rest);
        args = { prompt: positional[0], name: positional[1], ...flags };
        dispatchTool = tool;
        break;
      }
      case 'iterate': {
        const { positional, flags } = parseGenerateFlags(rest);
        args = { projectId: positional[0], prompt: positional.slice(1).join(' '), ...flags };
        dispatchTool = tool;
        break;
      }
      case 'pull': dispatchTool = tool; args = pullCliArgs(rest); break;
      case 'preview': dispatchTool = 'design_preview'; args = previewCliArgs(rest); break;
      case 'get': dispatchTool = 'design_get'; args = { projectId: rest[0], path: rest[1] }; break;
      case 'status': dispatchTool = 'design_status'; args = { projectId: rest[0] }; break;
      case 'check':
      case 'history': dispatchTool = tool; args = { projectId: rest[0] }; break;
      case 'edit':
        dispatchTool = 'design_edit';
        args = { projectId: rest[0], path: rest[1], edits: [{ oldString: rest[2], newString: rest[3] }] };
        break;
      case 'delete': dispatchTool = 'design_delete'; args = { projectId: rest[0], confirm: true }; break;
      case 'sync': {
        const { positional, flags } = parseSyncFlags(rest);
        if (!positional[0]) throw new Error('usage: node src/server.mjs sync <dir> [--account main|sub] [--timeout-ms <ms>]');
        const artifacts = (deps.designBackend ?? designBackend)() === 'artifacts';
        account = resolveAccount(flags.account);
        args = { dir: positional[0], account, timeoutMs: flags.timeoutMs };
        if (!artifacts && account === 'sub') throw new Error('sub account requires the artifacts backend');
        const sync = artifacts ? IMPL.design_system_sync : (deps.runDesignSync ?? runDesignSync);
        result = await withAccount(account, () => sync({
          ...args,
          onProgress: (line) => {
            const progress = { type: 'progress', stream: 'claude', text: line.slice(0, 2000) };
            if (send) send(progress);
            else stdoutLines.push(JSON.stringify(progress));
          },
        }));
        stdoutLines.push(JSON.stringify({
          type: 'result', ok: result.ok, account, skipped: result.skipped ?? false,
          systemName: result.systemName ?? null, error: result.error ?? null,
          verified: result.verified ?? null, flattened: result.flattened,
          flattenError: result.flattenError ?? null, projectId: result.projectId ?? null,
          url: result.url ?? null,
          ...(artifacts ? { artifactId: result.artifactId, sessionId: result.sessionId, created: result.created } : {}),
        }));
        return { exitCode: result.ok ? 0 : 1, stdoutLines };
      }
      default:
        return { exitCode: 0, stdoutLines: ['usage: node src/server.mjs <login|list|list-systems|create|iterate|pull|preview|get|status|check|history|edit|delete|sync> ...'] };
    }
    if (dispatchTool === 'design_history' && typeof IMPL.design_history !== 'function') {
      throw new Error('design_history is not available in this installation');
    }
    if (recording) account = (deps.resolveAccountFor ?? resolveAccountFor)(tool, args);
    result = await IMPL[dispatchTool](args);
    stdoutLines.push(JSON.stringify(result, null, 2));
    return { exitCode: 0, stdoutLines };
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    if (recording) {
      const durationMs = Date.now() - startedAt;
      const revision = tool === 'design_pull' ? snapshotForToolCall({ tool, args, result, error }) : null;
      recordToolCall({ tool, args, caller, result, error, durationMs, revision, account });
    }
  }
}
