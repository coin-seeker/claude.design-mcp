# claude.design-mcp

An MCP that drives the **real** [Claude Design](https://claude.ai/design) web app from your
editor/agent — log in once, then **create**, **iterate on**, and **pull** designs that
claude.ai/design generates **on your own account** (not a local imitation).

## How it works

- It drives **your own logged-in Chrome** (a dedicated profile) over CDP with
  [`playwright-core`](https://www.npmjs.com/package/playwright-core), and talks to the real
  `claude.ai/design` "Omelette" API as **you**, through your browser session.
- **Generation is triggered the way the website does it** — your prompt is typed into the
  design composer and submitted; the tool then waits for the turn to finish (the
  `ReleaseTurn` network signal + file-tree stability) and reports the files Claude Design
  wrote. Files are pulled back to local on request.
- Project metadata, files, deletes, and direct file edits use the documented JSON RPCs
  (`CreateProject` / `ListFiles` / `GetFile` / `WriteFiles` / `EditFile` / `DeleteProject`),
  run in-page so they share your session + Cloudflare clearance.
- **Not a `claude -p` mimic.** Every design is produced by claude.ai/design itself.

## Tools

| Tool | Does |
|------|------|
| `design_login` | One-time: open Chrome to log into claude.ai/design (session persists) |
| `design_list` | List your claude.ai/design projects |
| `design_create` | Create a project and generate a design from a prompt — `prompt`, `name?` |
| `design_iterate` | Send a follow-up prompt to modify a design — `projectId`, `prompt` |
| `design_pull` | Download a project's files to local — `projectId` or `name`, `dir?`, `zip?` |
| `design_preview` | Render a project's self-contained HTML to a full-page PNG for review — `projectId` or `name`, `path?`, `dir?`, `width?` |
| `design_get` | Read one file from a project — `projectId`, `path` |
| `design_status` | Report a project's chat/turn state — `projectId` |
| `design_edit` | Apply a direct file edit — `projectId`, `path`, `edits` |
| `design_delete` | Delete a project — `projectId` |

## Setup

```bash
npm install                  # installs playwright-core (NO browser download — uses your Chrome)
node src/server.mjs login    # opens Chrome once; log into claude.ai (session is then reused, invisibly)
```

Register as a local MCP (opencode example):

```json
{ "mcp": { "claude-design": { "type": "local", "command": ["node", "/abs/path/claude.design-mcp/src/server.mjs"], "enabled": true } } }
```

## CLI

```bash
node src/server.mjs login
node src/server.mjs list
node src/server.mjs create "minimal landing page for a coffee shop" coffee
node src/server.mjs iterate <projectId> "add a dark mode toggle to the header"
node src/server.mjs pull <projectId|name>
node src/server.mjs preview <projectId|name> [outDir] [width]
node src/server.mjs delete <projectId>
```

After the one-time `login`, `list`/`create`/`iterate`/`pull` run with **no visible window**
(off-screen Chrome) and reuse the persisted session.

## Requirements

- Node.js 22+ (uses built-in `fetch`/`WebSocket`; `playwright-core` is the only npm dependency)
- Google Chrome (the tools drive a dedicated Chrome profile)
- A claude.ai account with Design access (you log in once via `design_login`)

## Env

- `CLAUDE_DESIGN_PROFILE` — dedicated Chrome profile dir (default `~/.cache/claude-design-mcp/chrome-profile`)
- `CLAUDE_DESIGN_CHROME` — path to Google Chrome (default: macOS Google Chrome)
- `CLAUDE_DESIGN_CDP_PORT` — remote-debugging port (default `9377`)
- `CLAUDE_DESIGN_DIR` — where `design_pull` / `design_preview` write (default: the working folder)
- `CLAUDE_DESIGN_HEADLESS` — set `1` to drive headless Chrome instead of off-screen
- `CLAUDE_DESIGN_TURN_TIMEOUT_MS` — hard cap per generation turn (create ~420s, iterate ~300s defaults)
- `CLAUDE_DESIGN_QUIET_MS` — how long the turn network must stay silent before a generation is judged complete (default `45000`)

## When is a generation "done"?

`claude.ai/design` drives generation as **turns**: your prompt streams in over a `Chat` RPC,
kept alive by `RenewTurn` keepalives (~every 10s) and ended by a `ReleaseTurn`. `design_create` /
`design_iterate` return once the **files have settled AND the turn network has gone quiet** for
`CLAUDE_DESIGN_QUIET_MS` — comfortably longer than the keepalive interval, so a generation is **never
cut off mid-write** (you always get a complete, coherent design, not a half-rendered one).

Note that claude.ai often runs an **automatic refine pass** that starts ~30s *after* the first design
settles, so the design keeps improving on the server after the tool has returned its first complete
version. To get the most-refined output, **`design_pull` / `design_preview` always fetch the latest
state**, or raise `CLAUDE_DESIGN_QUIET_MS` (e.g. `60000`) to make `create` wait through later refine
passes (at the cost of a longer wait).
