#!/usr/bin/env node
import { parseGenerateFlags } from './cli.mjs';
import { IMPL, TOOLS } from './tools.mjs';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'claude.design-mcp', version: '0.2.0' },
    } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const fn = IMPL[params?.name];
    if (!fn) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${params?.name}` } });
      return;
    }
    try {
      const result = await fn(params.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (error) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${error.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}

function runMcp() {
  let buffer = '';
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
        .catch((error) => process.stderr.write(`parse/handle error: ${error.message}\n`));
    }
  });
  process.stderr.write('claude.design-mcp ready (stdio)\n');
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

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'login') console.log(JSON.stringify(await IMPL.design_login({}), null, 2));
    else if (cmd === 'list') console.log(JSON.stringify(await IMPL.design_list({}), null, 2));
    else if (cmd === 'create') {
      const { positional, flags } = parseGenerateFlags(rest);
      console.log(JSON.stringify(await IMPL.design_create({ prompt: positional[0], name: positional[1], ...flags }), null, 2));
    } else if (cmd === 'iterate') {
      const { positional, flags } = parseGenerateFlags(rest);
      console.log(JSON.stringify(await IMPL.design_iterate({ projectId: positional[0], prompt: positional.slice(1).join(' '), ...flags }), null, 2));
    }
    else if (cmd === 'pull') console.log(JSON.stringify(await IMPL.design_pull(pullCliArgs(rest)), null, 2));
    else if (cmd === 'preview') console.log(JSON.stringify(await IMPL.design_preview(previewCliArgs(rest)), null, 2));
    else if (cmd === 'get') console.log(JSON.stringify(await IMPL.design_get({ projectId: rest[0], path: rest[1] }), null, 2));
    else if (cmd === 'status') console.log(JSON.stringify(await IMPL.design_status({ projectId: rest[0] }), null, 2));
    else if (cmd === 'edit') console.log(JSON.stringify(await IMPL.design_edit({ projectId: rest[0], path: rest[1], edits: [{ oldString: rest[2], newString: rest[3] }] }), null, 2));
    else if (cmd === 'delete') console.log(JSON.stringify(await IMPL.design_delete({ projectId: rest[0] }), null, 2));
    else console.log('usage: node src/server.mjs <login|list|create|iterate|pull|preview|get|status|edit|delete> ...');
  } catch (error) {
    console.error('error:', error.message);
    process.exit(1);
  }
  process.exit(0); // CLI mode: exit after the command (the CDP browser connection otherwise lingers)
}

if (process.argv.slice(2).length) runCli(process.argv.slice(2));
else runMcp();
