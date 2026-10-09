import { ensureSession, withRpcPage } from '../session.mjs';
import { previewProject } from '../preview.mjs';
import { resolveDesign } from './listing.mjs';
import { getManifest } from './manifest.mjs';
import { loadArtifactAssets } from './assets.mjs';

const PREVIEW_DEPS = { ensureSession, withRpcPage, previewProject, resolveDesign, getManifest };

export async function artifactsPreview(args = {}, overrides = {}) {
  const deps = { ...PREVIEW_DEPS, ...overrides };
  const session = await deps.ensureSession({ visible: false });
  return deps.withRpcPage(session, async (page) => {
    const scoped = { ...session, page };
    const design = await deps.resolveDesign(scoped, args, deps);
    const manifest = await deps.getManifest(scoped, design.projectId, deps);
    const { assets } = await loadArtifactAssets(design.projectId, manifest, deps);
    const entries = [...assets.values()].map((asset) => ({ path: asset.path, type: 'file', contentType: asset.contentType }));
    const result = await deps.previewProject(scoped, design.projectId, {
      path: args.path?.replace(/^project\//, ''), out: args.dir ?? args.out,
      width: args.width, height: args.height, projectName: design.name,
    }, {
      ...deps,
      listPage: async () => ({ entries, total: entries.length }),
      getFile: async (_id, filePath) => {
        const asset = assets.get(filePath);
        if (!asset) throw new Error(`file not found: ${filePath}`);
        return { content: asset.bytes.toString('base64'), contentType: asset.contentType };
      },
    });
    return { ...result, backend: 'artifacts' };
  });
}
