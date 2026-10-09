import { ensureSession } from '../session.mjs';
import { withRpcPage } from '../operation-pages.mjs';
import { runDesignSync } from '../sync.mjs';
import { migrationFailure, runArtifactsMigration } from './migration.mjs';

const SYNC_DEPS = { ensureSession, withRpcPage, runDesignSync, runArtifactsMigration };

// Shared by the artifacts tool and the CLI, after the unchanged standalone upload.
export async function completeArtifactsSync(synced, overrides = {}) {
  const deps = { ...SYNC_DEPS, ...overrides };
  let migration = migrationFailure(synced.error ?? 'standalone sync failed; migration skipped');
  if (synced.ok) {
    try {
      const session = await deps.ensureSession();
      migration = await deps.withRpcPage(session, (page) =>
        deps.runArtifactsMigration({ ...session, page }, synced.projectId));
    } catch (error) {
      migration = migrationFailure(error);
    }
  }
  return { ...synced, backend: 'artifacts', artifactId: migration.artifactId, migration };
}

export async function artifactsSystemSync(args, overrides = {}) {
  const deps = { ...SYNC_DEPS, ...overrides };
  const synced = await deps.runDesignSync({ dir: args.dir, timeoutMs: args.timeoutMs });
  return completeArtifactsSync(synced, deps);
}
