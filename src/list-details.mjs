import { createPool } from './variants.mjs';
import { listAllFiles as fetchAllFiles } from './pull.mjs';
import { fileSignature, remoteUpdatedAtOf } from './signature.mjs';

export async function withListDetails(scoped, projects, { listAllFiles = fetchAllFiles, concurrency = 4 } = {}) {
  const acquire = createPool(concurrency);
  return Promise.all(projects.map((project) => acquire(async () => {
    const view = { projectId: project.projectId, name: project.name, type: project.type, viewedAt: project.viewedAt, isOwned: project.isOwned };
    if (project.type !== 'PROJECT_TYPE_PROJECT') return view;
    try {
      const entries = await listAllFiles(scoped, project.projectId);
      return { ...view, fileCount: entries.filter((entry) => entry.type === 'file').length, remoteUpdatedAt: remoteUpdatedAtOf(entries), signature: fileSignature(entries) };
    } catch (error) {
      return { ...view, detailsError: String(error?.message || error) };
    }
  })));
}
