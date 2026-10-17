#!/usr/bin/env node
import { runCliCommand } from './cli-run.mjs';
import { recordToolCall, snapshotForToolCall, splitCallerArgs } from './history.mjs';
import { IMPL, TOOLS } from './tools.mjs';
import { resolveAccountFor } from './account-routing.mjs';
import { listAccounts, withAccount } from './accounts.mjs';
import { idleCloseMs, startIdleClose } from './idle-close.mjs';
import { closeIdleChrome } from './session.mjs';
import { pathToFileURL } from 'node:url';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

export async function handle(message, overrides = {}) {
  const deps = { IMPL, send, resolveAccountFor, snapshotForToolCall, recordToolCall, ...overrides };
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
       serverInfo: { name: 'claude.design-mcp', version: '0.17.1' },
    } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'notifications/cancelled') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const fn = deps.IMPL[params?.name];
    if (!fn) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${params?.name}` } });
      return;
    }
    const { caller, rest } = splitCallerArgs(params?.arguments ?? {});
    const startedAt = Date.now();
    let outcome;
    let account = null;
    try {
      account = deps.resolveAccountFor(params.name, rest);
      const result = await fn(rest);
      outcome = { result, text: JSON.stringify(result, null, 2) };
    } catch (error) {
      outcome = { error };
    }
    const durationMs = Date.now() - startedAt; // measured before the snapshot: copying is not tool time
    // Post-processing only; a refused or failed snapshot just yields revision: null.
    const revision = deps.snapshotForToolCall({ tool: params.name, args: rest, result: outcome.result, error: outcome.error });
    // Exactly one history line per dispatch, success or failure; recordToolCall never throws.
    deps.recordToolCall({ tool: params.name, args: rest, caller, result: outcome.result, error: outcome.error, durationMs, revision, account });
    if (outcome.error) deps.send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${outcome.error.message}` }], isError: true } });
    else deps.send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: params.name === 'design_pull' ? JSON.stringify({ ...outcome.result, revision }, null, 2) : outcome.text }] } });
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}

function onLineError(error) {
  process.stderr.write(`parse/handle error: ${error.message}\n`);
  if (error instanceof SyntaxError) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
}

// stdout pipes are async on macOS, so exit only once the last response has drained;
// the unref'd timer still force-exits if a CDP handle keeps the loop alive.
function scheduleExit() {
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 50).unref();
}

function runMcp() {
  let buffer = '';
  process.on('uncaughtException', (error) => {
    process.stderr.write(`uncaughtException: ${error?.stack || error}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`unhandledRejection: ${reason?.stack || reason}\n`);
  });
  process.stdout.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      Promise.resolve()
        .then(() => handle(JSON.parse(line)))
        .catch(onLineError);
    }
  });
  process.stdin.on('end', () => {
    const line = buffer.trim();
    buffer = '';
    if (!line) {
      scheduleExit();
      return;
    }
    Promise.resolve()
      .then(() => handle(JSON.parse(line)))
      .catch(onLineError)
      .finally(scheduleExit);
  });
  // MCP server only: close each account's session Chrome after an idle period (0 disables).
  const idleMs = idleCloseMs();
  if (idleMs > 0) startIdleClose({ close: (account) => withAccount(account, () => closeIdleChrome()), accounts: listAccounts(), ms: idleMs });
  process.stderr.write('claude.design-mcp ready (stdio)\n');
}

async function runCli(argv) {
  try {
    const { exitCode, stdoutLines } = await runCliCommand(argv, {
      IMPL, recordToolCall, snapshotForToolCall, env: process.env, send,
    });
    for (const line of stdoutLines) {
      if (argv[0] === 'sync') send(JSON.parse(line));
      else console.log(line);
    }
    process.exit(exitCode); // CLI mode: the CDP browser connection otherwise lingers
  } catch (error) {
    console.error('error:', error.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).length) runCli(process.argv.slice(2));
  else runMcp();
}
