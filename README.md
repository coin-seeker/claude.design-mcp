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
  (`CreateProject` / `ListFiles` / `GetFile` / `EditFile` / `DeleteProject`),
  run in-page so they share your session + Cloudflare clearance.
- **Not a `claude -p` mimic.** Every design is produced by claude.ai/design itself.

## Official Design MCP and protocol verdict (2026-08-12)

This project is an independent CDP browser-automation MCP. It does not call the official
`api.anthropic.com/v1/design/mcp` endpoint. As described in [How it works](#how-it-works), it
uses `playwright-core` and CDP to drive a real Chrome session that is already logged into the
actual `claude.ai/design` web app.

The claude.ai/design UI's **Create prompt for Claude Code** export message hands off a project
URL in the form `https://claude.ai/design/p/<projectId>`. For this server, the matching flow is
to extract `<projectId>` from that URL and call `design_pull`. The official Design MCP is not
needed to receive the generated files.

The MCP protocol revision discussed around 2026-07-28, including the stateless wire-protocol
change adopted by some MCP ecosystems, has no practical effect on the current OpenCode stdio
client integration or tool contract. This server responds to initialization with the fixed
`protocolVersion: "2024-11-05"` handshake.

Re-review this verdict if any of these conditions occurs:

1. The OpenCode MCP client drops support for the older handshake version this server returns.
2. The project decides to replace its CDP browser-automation approach with the official
   `api.anthropic.com/v1/design/mcp` endpoint.
3. claude.ai changes its authentication or session model in a way that affects the CDP-driven
   login flow.

## Tools

| Tool | Does |
|------|------|
| `design_login` | One-time: open Chrome to log into claude.ai/design (session persists) |
| `design_list` | List your claude.ai/design projects |
| `design_create` | Create a project and generate a design from a prompt — `prompt`, **`designSystem` XOR `withoutDesignSystem: true`** (+ `withoutDesignSystemReason?`), `name?`, `wait?`, `model?`, `fresh?` |
| `design_variants` | Generate multiple design variants of one prompt in parallel — `prompt`, **`designSystem` XOR `withoutDesignSystem: true`** (+ `withoutDesignSystemReason?`), `count?`, `axis?`, `name?`, `preview?`, `model?` |
| `design_iterate` | Send a follow-up prompt to modify a design — `projectId`, `prompt`, `wait?`, `model?`, `designSystem?` |
| `design_pull` | Download a project's files to local — `projectId` or `name`, `dir?`, `zip?` |
| `design_preview` | Render a project's self-contained HTML to a full-page PNG for review — `projectId` or `name`, `path?`, `dir?`, `width?` |
| `design_get` | Read one file from a project — `projectId`, `path` |
| `design_status` | Report a project's chat/turn state — `projectId` |
| `design_check` | Poll and recover an asynchronous generation — `projectId`; returns `generating`, `awaiting_input`, `done`, `no_output`, `interrupted`, `stalled`, or `resume_exhausted` |
| `design_edit` | Apply a direct file edit — `projectId`, `path`, `edits` |
| `design_delete` | Delete a project — `projectId`, `confirm` (must be `true`; the call is rejected without it) |
| `design_system_sync` | Upload a materialized design-system package folder to claude.ai as a **design system**, by running Claude Code `/design-sync` in it — `dir` |
| `design_system_list` | List the design systems on your account (name + id), across every page of the project list |

Every tool also accepts an optional `caller` object — `{ directory, sessionID, agent, project? }` — that
the MCP client may inject to say who is calling. It is never a generation argument: the dispatcher strips
it before the handler runs and only records it in the call history.

## Call history

Every `tools/call` dispatch appends exactly one JSON line to
`~/.local/share/opencode-dashboard/claude-design-history/events.ndjsonl` (dir `0700`, file `0600`;
override the folder with `CLAUDE_DESIGN_HISTORY_DIR`), so a prompt history survives across MCP restarts.
A line carries `v`, `eventId`, `seq`, `ts`, `tool`, `durationMs`, `ok`, `error`, `projectId`, `projects`,
`projectName`, `prompt` (verbatim, never truncated), `model`, `designSystem`, `withoutDesignSystem`,
`withoutDesignSystemReason`, `wait`, `attemptId`, `caller`, `pullKind`, `revision`, and a whitelisted `result` summary (counts and ids only — **never** file
contents, base64, or environment values). Recording is best-effort observability: a failed write only warns
on stderr and never turns a working tool call into an error. The CLI path is not recorded.

### Revision snapshots

A successful plain `design_pull` (`pullKind: "default"` — no `dir`, no `zip`) also snapshots the pulled
manifest into `<CLAUDE_DESIGN_DIR>/.revisions/<projectId>/<revisionId>/`, outside the pulled tree, so a
design's edit history can be diffed later. `revisionId` is `<YYYYMMDDTHHmmssSSS>-<uuid8>` in UTC, so name
order is time order. Each folder carries a `.meta.json` with the per-file SHA-256 list, a total `hash`, and
`incomplete: true` when the pull reported partial file errors. The snapshot is staged in
`.staging-<revisionId>/` and atomically renamed, so listers only ever see finished revisions (skip any name
starting with `.`). A pull whose content hash and completeness both match the previous revision is skipped
and reports `revision: null`, meaning "unchanged — the previous revision is still current". Snapshot
failures are non-fatal in the same way: `revision: null` plus an stderr warning, tool result untouched.

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
node src/server.mjs list-systems
node src/server.mjs create "simple pricing card" pricing --design-system "Frontend Design System"
node src/server.mjs create "minimal landing page for a coffee shop" coffee --model opus --without-design-system
node src/server.mjs iterate <projectId> "add a dark mode toggle to the header" --model sonnet
node src/server.mjs check <projectId>
node src/server.mjs pull <projectId|name>
node src/server.mjs preview <projectId|name> [outDir] [width]
node src/server.mjs delete <projectId>
node src/server.mjs sync <packageDir> [--timeout-ms 900000]
```

After the one-time `login`, `list`/`create`/`iterate`/`pull` run with **no visible window**
(off-screen Chrome) and reuse the persisted session.

## Generation options

- `design_create`, `design_iterate`, and `design_variants` accept an optional `model`.
  Use a family (`opus`, `sonnet`, `haiku`, or `fable`) to select that family's newest
  version from the live claude.ai/design menu. Pin a version with forms such as
  `opus-4.8`, `opus-5`, `opus 5.0`, `claude-opus-4-8`, or
  `anthropic/claude-opus-5`. New family versions become available automatically when
  they appear in the site menu. If a requested version is unavailable, the error lists
  the live menu options. For CLI `create` and `iterate`, pass the same value to `--model`.
- `design_create`, `design_iterate`, and `design_variants` accept a `designSystem`
  (CLI `--design-system`), the name of one of the account design systems reported by
  `design_system_list`. It is matched case-insensitively, an unambiguous partial name works,
  and an unknown name errors with the list the composer offers. The chosen system replaces the
  org default rather than adding to it, and the result echoes the resolved name. claude.ai only
  offers the picker **while a project has produced no design yet**, so `designSystem` belongs on
  `design_create`; on `design_iterate` it works only for such a project and otherwise errors
  instead of silently ignoring the request. `design_variants` grounds every variant in the same
  system.
- **Grounding is mandatory on `design_create` and `design_variants`.** Each call must carry
  exactly one of a non-blank `designSystem` or `withoutDesignSystem: true` (the boolean `true`,
  not `"true"` or `1`) — never both, never neither. A violation is refused with one fixed message
  that names `list_claude_synced_systems` / `design_system_list` as the way to discover the
  available names, and the refusal happens **before** a browser session, an operation page, or a
  project exists, so a rejected call leaves the account untouched. On `design_variants` the check
  runs above the fan-out, so a refused call creates zero projects instead of returning per-variant
  errors. An opt-out may carry a free-text `withoutDesignSystemReason`, which is only valid
  together with `withoutDesignSystem: true`; both are echoed in the result and recorded in the
  call history. The CLI equivalent is `create --without-design-system`; `iterate` rejects that
  flag as unknown. `design_iterate` is deliberately **not** gated: a project that already holds a
  design no longer offers the picker, so there is nothing to choose there.
- `design_variants` forces `fresh: true` on every project it creates. Each variant is named
  `<base>-v<N>`, and without `fresh` a rerun would reuse the same-named project from an earlier
  fan-out — a project that already holds a design, where the design system can no longer attach.
- `design_create` and `design_iterate` accept `wait` (default `true`). Set `wait: false`
  to return after a verified `Chat` POST and the bounded question-form watch with
  `{ submitted: true, pending: true }`; the CLI equivalent is `--no-wait`. A click or
  Enter press that does not produce a `Chat` request fails instead of reporting success.
- `design_create` with an explicit `name` is **find-or-create**: an existing project with
  that exact name is reused (newest wins on collisions) and the result carries
  `reused: true`, so repeated calls iterate one project instead of piling up duplicates.
  Pass `fresh: true` to force a new project. Without `name` (prompt-derived name), every
  call creates a new project as before.
- Poll submitted work with `design_check({ projectId })`, or
  `node src/server.mjs check <projectId>`. Its `status` is `generating`,
  `awaiting_input`, `done`, `no_output`, `interrupted`, `stalled`, or `resume_exhausted`. Each check reuses the
  held owner page while a turn is active (without reloading it), answers a question form when possible, and automatically clicks the
  interrupted banner's `Resume` button. `interrupted` means the banner was present but
  could not be resumed; `stalled` means the file tree was stable with no generated files
  and the last message was still the user's prompt. `resume_exhausted` is terminal after
  three consecutive Resume attempts and includes `resumeAttempts`, `maxResumeAttempts`,
  and `problem: "resume_attempts_exhausted"`. `_ds/**` design-system material is not counted
  as generated output.

## Asynchronous workflow

```bash
# 1. Submit without waiting
node src/server.mjs create "카드 UI" my-card --no-wait --model opus
# → { projectId: "...", submitted: true, pending: true }

# 2. Continue with other work...

# 3. Poll for completion (every 2-5 minutes is recommended)
node src/server.mjs check <projectId>
# → { status: "done", files: [...] }

# 4. Pull and preview the finished design
node src/server.mjs pull <projectId>
node src/server.mjs preview <projectId>
```

## Requirements

- Node.js 22+ (uses built-in `fetch`/`WebSocket`; `playwright-core` is the only npm dependency)
- Google Chrome (the tools drive a dedicated Chrome profile)
- A claude.ai account with Design access (you log in once via `design_login`)

## Env

- `CLAUDE_DESIGN_PROFILE` — dedicated Chrome profile dir (default `~/.cache/claude-design-mcp/chrome-profile`)
- `CLAUDE_DESIGN_CHROME` — path to Google Chrome (default: macOS Google Chrome)
- `CLAUDE_DESIGN_CDP_PORT` — remote-debugging port (default `9377`)
- `CLAUDE_DESIGN_DIR` — where `design_pull` / `design_preview` write, each into its own `<project>/` folder (default: the working folder); an explicit `dir` argument is used verbatim
- `CLAUDE_DESIGN_HISTORY_DIR` — where the `tools/call` history is appended (default `~/.local/share/opencode-dashboard/claude-design-history`, file `events.ndjsonl`)
- `CLAUDE_DESIGN_HEADLESS` — set `1` to drive headless Chrome instead of off-screen
- `CLAUDE_DESIGN_TURN_TIMEOUT_MS` — hard cap per generation turn (create ~360s, iterate ~240s defaults)
- `CLAUDE_DESIGN_QUIET_MS` — how long the turn network must stay silent before a generation is judged complete (default `20000`)
- `CLAUDE_DESIGN_PAGE_LEASE_MS` — independent hard cap for an async owner page if its completion monitor hangs (default `2700000`, 45 minutes)
- `CLAUDE_DESIGN_CLAUDE_BIN` — Claude Code binary used by `design_system_sync` (default `claude`)
- `CLAUDE_DESIGN_SYNC_TIMEOUT_MS` — hard cap for one `/design-sync` run (default `900000`, 15 minutes)

## Design-system sync

`design_system_sync` (CLI: `sync <dir>`) runs
`claude -p "/design-sync <pre-approval>" --dangerously-skip-permissions --output-format stream-json --verbose`
with the package folder as its working directory and reports what the sync uploaded. After a
successful tokens-only sync, it uses the logged-in Chrome/CDP session to replace the uploaded
`styles.css` import shim with the generated custom-property CSS from `ds-bundle/_ds_bundle.css`.

- The folder must already be a package (`package.json` + a CSS entry such as `styles.css`, plus
  `tokens/*.json`, `guidelines/*.md`, `README.md`). Components are optional — a tokens-only
  package is accepted. The tool refuses before spawning if `package.json` is missing.
- **Exit status is not the success signal.** A refused sync still exits `0` with
  `subtype: "success"`, so the result is only `ok: true` when the reply carries a real project
  link; otherwise you get `{ ok: false, error, raw }` with the full output for diagnosis.
- A first run creates the project and writes `.design-sync/config.json`, which **pins** later runs
  to the same project (an unchanged re-run is then a no-op instead of a duplicate). If your
  pipeline regenerates the folder, snapshot `.design-sync/` before replacing it and restore it
  afterwards — this tool never writes the package itself.
- **The prompt carries a pre-approval (`SYNC_ARGS` in `src/sync.mjs`), and it is load-bearing on a
  first run.** `/design-sync` asks for two `AskUserQuestion` confirmations when the folder has no
  pin — accept the time/cost, then confirm the new project's name before `create_project` — and
  `claude -p` has no `AskUserQuestion` tool, so the turn would end with the question and upload
  nothing (exit `0`, `subtype: "success"`, no project link). The skill's own escape hatch ("if their
  request already acknowledged the time/cost… continue without re-asking") is what the pre-approval
  invokes, and it names the fresh-project creation explicitly. A pinned re-sync never hits either
  gate, which is why this only ever surfaced on a first-time sync. Claude Code appends the text
  after the slash command to the skill body as a fenced `## Hint` block, so it must stay one
  positional string with no triple backtick in it.
- A first sync takes ~10 minutes; unchanged re-runs take ~2. The CLI exits `1` on a failed sync.
- The result adds `flattened: true|false`. A post-sync browser/write failure is reported as
  `flattenError` while the completed upload remains `ok: true`.

`design_system_list` (CLI: `list-systems`) is the read side of the same feature. claude.ai has no
separate design-systems endpoint — design systems are returned by the ordinary project list RPC
tagged `PROJECT_TYPE_DESIGN_SYSTEM`, which pages 20 at a time, so the tool follows every page and
returns `[{ name, id, publishedAt?, viewedAt? }]` (`publishedAt` appears only once a system has
been published). Use it to confirm what `design_system_sync` actually landed on the account.
`scripts/probe-design-systems.mjs` re-captures that live shape if the API changes.

## When is a generation "done"?

`claude.ai/design` drives generation as **turns**: your prompt streams in over a `Chat` RPC,
kept alive by `RenewTurn` keepalives (~every 10s) and ended by a `ReleaseTurn`. `design_create` /
`design_iterate` return once the **files have settled AND the turn network has gone quiet** for
`CLAUDE_DESIGN_QUIET_MS` — comfortably longer than the keepalive interval, so a generation is **never
cut off mid-write** (you always get a complete, coherent design, not a half-rendered one).

If a generation reaches its hard deadline before the quiet/stability checks complete, the result includes
`timedOut: true`. Normal completions omit the field entirely; treat its presence as a signal that the
returned files are the best available snapshot at the timeout rather than a fully quiet turn.

Note that claude.ai often runs an **automatic refine pass** that starts ~30s *after* the first design
settles, so the design keeps improving on the server after the tool has returned its first complete
version. To get the most-refined output, **`design_pull` / `design_preview` always fetch the latest
state**, or raise `CLAUDE_DESIGN_QUIET_MS` (e.g. `60000`) to make `create` wait through later refine
passes (at the cost of a longer wait).
