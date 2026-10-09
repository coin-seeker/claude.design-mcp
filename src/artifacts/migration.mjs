import { setTimeout as sleepDefault } from 'node:timers/promises';
import { designApiRequest } from './api.mjs';

const RUN_PATH = '/v1/design/org/design-system-migration/run';

export function migrationFailure(error) {
  return {
    ok: false, artifactId: null, artifactUrl: null, outcome: null, reason: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function runArtifactsMigration(scoped, standaloneProjectId, {
  sleep = sleepDefault, timeoutMs = 90_000, now = Date.now,
} = {}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  try {
    // The POST body was not captured; a rejection is a reported migration failure.
    await designApiRequest(scoped, 'POST', RUN_PATH, {});
    while (now() < deadline) {
      let page = await designApiRequest(scoped, 'GET', `${RUN_PATH}?page_size=20`);
      if (Date.parse(page?.run?.created_at) >= startedAt - 5000 && page.run.ended_at) {
        const runCreatedAt = page.run.created_at;
        let item = page.items?.find((entry) => entry.project_id === standaloneProjectId);
        const visited = new Set();
        while (!item && page.next_page_token && now() < deadline) {
          const token = page.next_page_token;
          if (visited.has(token)) throw new Error('migration pagination repeated a page token');
          visited.add(token);
          page = await designApiRequest(scoped, 'GET', `${RUN_PATH}?page_size=20&page_token=${encodeURIComponent(token)}`);
          if (page?.run?.created_at !== runCreatedAt) throw new Error('migration run changed while reading items');
          item = page.items?.find((entry) => entry.project_id === standaloneProjectId);
        }
        if (now() >= deadline) break;
        const artifactUrl = item?.artifact_url ?? null;
        const artifactId = artifactUrl?.match(/[0-9a-f-]{36}/)?.[0] ?? null;
        return { ok: true, artifactId, artifactUrl, outcome: item?.outcome ?? null, reason: item?.reason ?? null };
      }
      const remaining = deadline - now();
      if (remaining > 0) await sleep(Math.min(3000, remaining));
    }
    return migrationFailure(`artifacts migration timed out after ${timeoutMs}ms`);
  } catch (error) {
    return migrationFailure(error);
  }
}
