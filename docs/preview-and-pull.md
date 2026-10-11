# Preview and pull contracts (0.14.0)

## MCP preview

```json
{"name":"design_preview","arguments":{"projectId":"<artifact UUID>","path":"project/s1.html#screen=session","dir":"/absolute/scratch","width":1440,"height":900,"clip":{"x":0,"y":0,"width":640,"height":480}}}
```

- Artifacts strip `project/`; standalone uses its listing path unchanged.
- Split at the first `?` or `#`. Fetch only the bare file; preserve the complete
  suffix for navigation. Spaces in filenames are encoded independently of URL state.
- Output filenames retain the bare path and add a sanitized suffix plus a short
  SHA-256 tag. No suffix retains the previous filename.
- Clips use finite CSS-pixel numbers (fractions accepted), x/y >= 0 and dimensions > 0.
  The rectangle must fit 10000w/20000h bounds and 40M pixels. Validation precedes
  session acquisition, manifest fetch and renderer launch. Use a region within the page.
- `clip` is forwarded unchanged to Playwright's screenshot. `pageSize` stays the full
  document; `capturedSize` is the selected region. Intentional crops are not truncation.
- Return shape remains `{projectId, path, image, pageSize, capturedSize, truncated}`
  (plus backend/missingAssets when relevant). Path and image remain NFC-normalized.
- Rendering owns its context; the existing claude.ai page is never navigated or closed.

The simple positional CLI `preview <projectId|name> [outDir] [width]` remains unchanged;
use stdio `tools/call` for path suffixes and clips.

## MCP pull revision

Successful `design_pull` JSON text adds `revision: "<snapshot id>" | null` after snapshot
processing. Plain pulls can create snapshots. Identical content, explicit `dir`, zip,
or a failed snapshot yields null. Snapshot and recording failures never turn success
into an error, and history receives the original pull result plus its existing revision
field. Failed tool calls retain the existing `error: ...` text and `isError:true`.

The response addition applies to MCP calls, not the positional CLI pull output.
