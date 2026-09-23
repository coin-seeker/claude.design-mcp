import { createPool } from './variants.mjs';
import { listAllFiles as fetchAllFiles, projectView, readAllProjectItems } from './pull.mjs';
import { fileSignature, remoteUpdatedAtOf } from './signature.mjs';

export async function withListDetails(scoped, projects, { listAllFiles = fetchAllFiles, concurrency = 4, only } = {}) {
  const acquire = createPool(concurrency);
  const wanted = Array.isArray(only) ? new Set(only.map(String)) : null;
  return Promise.all(projects.map((project) => acquire(async () => {
    const view = { projectId: project.projectId, name: project.name, type: project.type, viewedAt: project.viewedAt, isOwned: project.isOwned };
    if (project.type !== 'PROJECT_TYPE_PROJECT' || (wanted && !wanted.has(String(project.projectId)))) return view;
    try {
      const entries = await listAllFiles(scoped, project.projectId);
      return { ...view, fileCount: entries.filter((entry) => entry.type === 'file').length, remoteUpdatedAt: remoteUpdatedAtOf(entries), signature: fileSignature(entries) };
    } catch (error) {
      return { ...view, detailsError: String(error?.message || error) };
    }
  })));
}

export function listLimit(value) {
  if (value === undefined || value === null) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  return limit;
}

// design_list body. A limited read never replaces session.projects: pull/resolveProject rely on the
// full cached listing, so only the unlimited path goes through deps.listProjects.
export async function readListing(scoped, args, limit, deps) {
  const projects = limit === undefined
    ? await deps.listProjects(scoped, { refresh: true })
    : (await readAllProjectItems(scoped, deps.omelette, { limit })).map(projectView);
  if (args.details !== true) return projects;
  const only = Array.isArray(args.detailsFor) ? args.detailsFor.map(String) : undefined;
  return withListDetails(scoped, projects, { listAllFiles: deps.listAllFiles, only });
}
