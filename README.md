# claude.design-mcp

An MCP that drives the **real** [Claude Design](https://claude.ai/artifacts/design) web app from your
editor/agent — log in once, then **create**, **iterate on**, and **pull** designs that
Claude Design generates **on your own account** (not a local imitation).

## Backends

Version **0.7.0** defaults to `CLAUDE_DESIGN_BACKEND=artifacts`: a claude.ai **Design
artifact + Cowork session**. Set `CLAUDE_DESIGN_BACKEND=standalone` to use the unchanged
`claude.ai/design` service, which remains selectable until it closes on **2026-12-14**.
Tool names and input schemas are identical; the backend is selected on each call.
An invalid backend value rejects calls, but does not prevent initialization or tool listing.

For artifacts, `projectId` is the artifact UUID, `sessionId` is the Cowork `cse_…` id,
and results identify `backend: "artifacts"`. Listing and generation URLs use
`https://claude.ai/cowork/<sessionId>?artifact=<projectId>`; an artifact without a known
session links to `https://claude.ai/code/artifact/<projectId>`. Standalone project URLs
remain `https://claude.ai/design/p/<projectId>`; ids from one backend are not interchangeable.

`design_check` reads the Cowork session, events and artifact manifest through APIs,
without navigating the project page or automatically approving permission requests:

| Status | Artifacts meaning |
|---|---|
| `awaiting_input` | Session requires action (`requiresAction` types), or the turn ended in bucket `blocked` with no new output (`problem: "need_input: <Claude's question>"`) |
| `done` | Successful result after the latest real prompt, with non-empty output changed from the submission baseline (or no known baseline); a `blocked` bucket adds `problem: "need_input: …"` |
| `no_output` | Successful result, but empty output or the same signature as the baseline |
| `interrupted` | Error/non-success result, or an idle completed worker with a prompt but no result |
| `generating` | Worker is active and its latest event is within the stall threshold |
| `stalled` | No real prompt, or active worker whose last event exceeds the stall threshold |

Artifacts checks return `checkPath: "artifacts"`, `answeredQuestions: false`, and never
auto-resume; `resume_exhausted` belongs only to the standalone backend. Tool-result user
events and composer echoes (`<local-command-stdout>Set model…`) are not real prompts; zero-turn
`result` events are session handshakes. A worker counts as finished when it is idle in bucket
`completed` or `blocked`. `costUsd` is the turn's cost (session `total_cost_usd` delta). `CLAUDE_DESIGN_STALL_MS` defaults to `600000` (10 minutes).

Artifacts pulls strip the manifest's `project/` prefix, write the Design runtime as
`support.js` next to each `*.dc.html`, download referenced assets into `_blob/`, and rewrite
successful blob references to relative paths. Failed downloads are reported in `errors`
and keep their original references. Zip pulls archive the same layout. Default pulls
(no explicit `dir` or `zip`) still create revision snapshots, including runtime and blobs.
Signatures hash sorted, prefix-stripped `path:sha256` pairs for `project/` files only.

**`design_edit` consumes usage**: there is no artifacts file-write API. It runs an
instructed Haiku/low Cowork turn (about $0.03 in live QA) in a background operation page, requires each old string to occur
exactly once, then re-reads the file to verify the literal edits. It is not a direct RPC edit.

`design_system_sync` still uploads through the **standalone** Claude Code `/design-sync`
flow, then runs the migration to a Design System artifact. It therefore depends on the
standalone service; results add `artifactId` and `migration` (with independent `ok`,
outcome and error fields). A successful upload does not guarantee successful migration.

The local artifact/session index is
`~/.cache/claude-design-mcp/artifacts-index.json`; override its directory with
`CLAUDE_DESIGN_STATE_DIR`. It records names, sessions and submission baselines; writes
are atomic with private directory/file permissions (`0700`/`0600`).

## How it works

- It drives **your own logged-in Chrome** (a dedicated profile) over CDP with
  [`playwright-core`](https://www.npmjs.com/package/playwright-core), and talks to the real
  frame and Cowork session APIs as **you**, through your browser session. The selectable
  standalone backend uses the `claude.ai/design` "Omelette" API instead.
- **Generation is triggered the way the website does it** — your prompt is typed into the
  design composer and submitted; the tool then waits for the turn to finish (the
   Cowork session result + artifact signature; standalone uses `ReleaseTurn` and file-tree stability) and reports the files Claude Design
  wrote. Files are pulled back to local on request.
- Artifacts metadata and deletes use frame APIs; downloads use manifest file URLs.
  Standalone metadata, files, deletes, and direct file edits use the JSON RPCs
  (`CreateProject` / `ListFiles` / `GetFile` / `EditFile` / `DeleteProject`),
  run in-page so they share your session + Cloudflare clearance.
- Focus-free reads use an existing claude.ai page without navigating or focusing it. If none
  exists, CDP creates one background target; subsequent reads reuse that target.
- **Not a `claude -p` mimic.** Every design is produced by claude.ai itself.

## Official Design MCP and protocol verdict (2026-08-12)

This project is an independent CDP browser-automation MCP. It does not call the official
`api.anthropic.com/v1/design/mcp` endpoint. As described in [How it works](#how-it-works), it
uses `playwright-core` and CDP to drive a real Chrome session that is already logged into the
actual claude.ai web app. The dated export example below describes the standalone backend.

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
| `design_login` | One-time: open Chrome to log into Claude Design (session persists) |
| `design_list` | List your Design artifacts (standalone: projects); `details?: true` includes file count, remote update time and signature |
| `design_create` | Create a project and generate a design from a prompt — `prompt`, **`designSystem` XOR `withoutDesignSystem: true`** (+ `withoutDesignSystemReason?`), `name?`, `wait?`, `model?`, `fresh?` |
| `design_variants` | Generate multiple design variants of one prompt in parallel — `prompt`, **`designSystem` XOR `withoutDesignSystem: true`** (+ `withoutDesignSystemReason?`), `count?`, `axis?`, `name?`, `preview?`, `model?` |
| `design_iterate` | Send a follow-up prompt to modify a design — `projectId`, `prompt`, `wait?`, `model?`, `designSystem?` |
| `design_pull` | Download a project's files to local — `projectId` or `name`, `dir?`, `zip?` |
| `design_preview` | Render a project's self-contained HTML to a full-page PNG for review — `projectId` or `name`, `path?`, `dir?`, `width?` |
| `design_get` | Read one file from a project — `projectId`, `path` |
| `design_status` | Report a project's chat/turn state — `projectId` |
| `design_check` | Poll an asynchronous generation — `projectId`; artifacts status mapping above, `checkPath: "artifacts"`; standalone may recover via `held`, `rpc`, or `ui` |
| `design_edit` | Verified literal file edits via a usage-consuming Cowork turn (standalone: direct RPC) — `projectId`, `path`, `edits` |
| `design_delete` | Delete a project — `projectId`, `confirm` (must be `true`; the call is rejected without it) |
| `design_system_sync` | Upload a materialized design-system package folder to claude.ai as a **design system**, by running Claude Code `/design-sync` in it — `dir` |
| `design_system_list` | List Design System instances (name + id + optional publication/default fields); standalone follows the project list |

Every tool also accepts an optional `caller` object — `{ directory, sessionID, agent, project? }` — that
the MCP client may inject to say who is calling. It is never a generation argument: the dispatcher strips
it before the handler runs and only records it in the call history.

## Call history

Every `tools/call` dispatch appends exactly one JSON line to
`~/.local/share/opencode-dashboard/claude-design-history/events.ndjsonl` (dir `0700`, file `0600`;
override the folder with `CLAUDE_DESIGN_HISTORY_DIR`), so a prompt history survives across MCP restarts.
A line carries `v`, `eventId`, `seq`, `ts`, `tool`, `durationMs`, `ok`, `error`, `projectId`, `projects`,
`projectName`, `prompt` (verbatim, never truncated), `model`, `designSystem`, `withoutDesignSystem`,
`withoutDesignSystemReason`, `wait`, `attemptId`, `caller`, `pullKind`, `revision`, `backend`, `sessionId`, and a whitelisted `result` summary (counts, ids, file signature, and remote update time only — **never** file
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

### Focus-free reads

`design_list`, `design_pull`, `design_get`, `design_status`, `design_preview`, and
`design_system_list` run RPCs without opening, focusing, or navigating a visible tab.
`design_delete` uses the same background API path but **changes remote data**.
`design_edit` opens an operation page for a Cowork turn (standalone: focus-free RPC).
`design_preview` renders with a separate headless browser by default. Artifacts
`design_check` is API-only; standalone checks may use held pages or UI fallback.
Generation (`design_create`, `design_iterate`) uses its composer operation page.

### `design_list` details

Pass `{ "details": true }` (CLI: `list --details`) to receive `fileCount`,
`remoteUpdatedAt`, and `signature` for each ordinary project. Design systems do not
have these file stats. Artifacts signatures use sorted `path:sha256` pairs for project
files; standalone uses `path:version` pairs. Both match non-zip `design_pull` results.

`{ "limit": 20 }` (CLI: `list --limit 20`) reads only the first N projects —
standalone `ListProjects` returns favourites first, then the most recently viewed — so a limit of
20 costs one RPC. A limited read never replaces the cached full listing that
`design_pull` uses. With `details: true`, `{ "detailsFor": ["<projectId>", ...] }`
restricts the per-artifact manifests (standalone: `ListFiles`) to those ids; other items come back
without file stats.

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
node src/server.mjs list --details
node src/server.mjs list --limit 20 --details
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

After the one-time `login`, reads reuse the Chrome session without changing the
frontmost tab. Generation still uses its composer page.

## Generation options

- `design_create`, `design_iterate`, and `design_variants` accept an optional `model`.
  Use a family (`opus`, `sonnet`, `haiku`, or `fable`) to select that family's newest
  version from the live claude.ai/design menu. Pin a version with forms such as
  `opus-5.5`, `opus-5`, `opus 5.0`, `claude-opus-5-5`, or
  `anthropic/claude-opus-5-5`. Without `model` the server defaults to `opus-5.5`
  New family versions become available automatically when
  they appear in the site menu. If a requested version is unavailable, the error lists
  the live menu options. For CLI `create` and `iterate`, pass the same value to `--model`.
- `design_create` and `design_iterate` accept an optional `effort`: `low`, `medium`, `high`,
  `extra`, or `max`, matching the composer's Effort menu (`xhigh` is an alias of `extra`).
  Without `effort` every generation uses `high`. If the composer cannot be set to the effort
  (explicit or default) the call fails before the prompt is sent, with the live options in the
  error. A page reload resets the composer to Medium, so the effort is re-applied right before
  every submit and also before the follow-up turns the server starts itself: the clarifying-question
   standalone form's Continue (skipped, leaving `awaiting_input`, if the effort cannot be set) and the
   standalone interruption Resume in `design_check`. Those use the project's last requested effort in this
  server process, else `high`. CLI: `--effort <value>`.
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
- Artifacts backend: the Cowork composer offers the picker even after a design exists, so
  `designSystem` on `design_iterate` (and on a name-reused `design_create`) re-selects the system
  for that turn; it errors only if no picker is shown. `design_variants` submits every variant with
  `wait: false` and returns pending ids without previews — poll each with `design_check`.
- `design_variants` forces `fresh: true` on every project it creates. Each variant is named
  `<base>-v<N>`, and without `fresh` a rerun would reuse the same-named project from an earlier
  fan-out — a project that already holds a design, where the design system can no longer attach.
- `design_create` and `design_iterate` accept `wait` (default `true`). Set `wait: false`
   to return after a confirmed Cowork submission (standalone: verified `Chat` POST and bounded question-form watch) with
  `{ submitted: true, pending: true }`; the CLI equivalent is `--no-wait`. A click or
   Enter press that does not confirm submission fails instead of reporting success.
- `design_create` with an explicit `name` is **find-or-create**: an existing project with
  that exact name is reused (newest wins on collisions) and the result carries
  `reused: true`, so repeated calls iterate one project instead of piling up duplicates.
  Pass `fresh: true` to force a new project. Without `name` (prompt-derived name), every
  call creates a new project as before.
- Poll submitted work with `design_check({ projectId })`, or
  `node src/server.mjs check <projectId>`. Its `status` is `generating`,
  `awaiting_input`, `done`, `no_output`, `interrupted`, `stalled`, or `resume_exhausted`. Each check reuses the
   held owner page **on standalone only** while a turn is active (without reloading it), answers a question form when possible, and automatically clicks the
  interrupted banner's `Resume` button. `interrupted` means the banner was present but
  could not be resumed; `stalled` means the file tree was stable with no generated files
  and the last message was still the user's prompt. `resume_exhausted` is terminal after
  three consecutive Resume attempts and includes `resumeAttempts`, `maxResumeAttempts`,
  and `problem: "resume_attempts_exhausted"`. `_ds/**` design-system material is not counted
  as generated output.
- On standalone, a turn that claude.ai ends inside a thinking block without writing anything is reported as
  `no_output` with `cutOff: true` and `problem: "turn_cut_off"`, even when earlier turns left
  files behind (send a follow-up `design_iterate`). While the server still holds the turn's page it
  stays `generating` and the page monitor makes the call.
- On standalone, when a turn ends with `ready_for_verification`, the held page stays open up to 5 minutes
  (`CLAUDE_DESIGN_VERIFY_GRACE_MS`) so the background check can report back. If the page shows
  "The background check didn't finish", `design_check` clicks `Re-run check` for a turn that
  produced files (at most twice per project) and returns `generating` with `verificationRerun: true`.
  Transient RPC timeouts inside the monitor no longer close a page mid-generation.

## Asynchronous workflow

```bash
# 1. Submit without waiting
node src/server.mjs create "카드 UI" my-card --no-wait --model opus --without-design-system
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

- `CLAUDE_DESIGN_BACKEND` — `artifacts` (default) or `standalone` (legacy service closes 2026-12-14)
- `CLAUDE_DESIGN_STATE_DIR` — artifact/session index directory (default `~/.cache/claude-design-mcp`)
- `CLAUDE_DESIGN_STALL_MS` — artifacts active-worker inactivity threshold (default `600000`)
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
- **A project link is necessary but not sufficient.** After the link, the tool reads the remote
  `manifest.json` (GetFile over the logged-in session) and compares `designSystemId`, `version` and
  the file `path`/`sha256` list with the local `manifest.json` (`generatedAt` is ignored). A
  mismatch, an unreadable remote, or a missing remote manifest on a `prebuilt-*` package turns the
  run into `ok: false` (`… — upload did not land`) and skips flatten. This exists because a re-sync
  once compared local files only with the local manifest, declared "already in sync", and left the
  remote a month behind.
- The result adds `verified: true | false | null`: `true` = remote manifest matches, `false` = the
  check failed (the run is `ok: false`), `null` = skipped — no local `manifest.json`, or a
  converter-shape package (`.design-sync/config.json` `shape` not `prebuilt-*`) whose remote has no
  manifest (GetFile returns empty content for a missing path, and converter uploads never carry one).
- Failures name their cause: a DesignSync authorization refusal anywhere in the transcript becomes
  `DesignSync authorization is missing — run /design-login once …`, and a non-zero exit or
  `is_error` result appends Claude's own result text (first 300 chars), e.g.
  `claude exited with non-zero status 1: API Error: 400 … Run 'claude update'`.
- A first sync takes ~10 minutes; unchanged re-runs take ~2. The CLI exits `1` on a failed sync.
- The result adds `flattened: true|false`. A package without `ds-bundle/styles.css` (prebuilt
  packages author a real root `styles.css`) skips flatten with no `flattenError`. A post-sync
  browser/write failure is reported as `flattenError` while the completed upload remains `ok: true`.

With artifacts, `design_system_list` (CLI: `list-systems`) reads Design System type instances
and returns `[{ name, id, publishedAt?, isDefault? }]`. With standalone, claude.ai has no
separate design-systems endpoint — design systems are returned by the ordinary project list RPC
tagged `PROJECT_TYPE_DESIGN_SYSTEM`, which pages 20 at a time, so the tool follows every page and
returns `[{ name, id, publishedAt?, viewedAt? }]` (`publishedAt` appears only once a system has
been published). Use it to confirm what `design_system_sync` actually landed on the account.
`scripts/probe-design-systems.mjs` re-captures that live shape if the API changes.

## When is a generation "done"?

For artifacts, use the Cowork result/signature mapping in [Backends](#backends).
The network quiet/stability behavior below applies **only to standalone**.

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
