// claude.ai/design has no dedicated design-systems endpoint: an account's design systems come
// back from the same ListProjects RPC as ordinary projects, tagged PROJECT_TYPE_DESIGN_SYSTEM
// (recorded by scripts/probe-design-systems.mjs). This reads that list through the logged-in
// browser session — it is list-only and never uploads.
import { omelette } from './rpc.mjs';
import { ensureSession, loginHelp, NotLoggedInError, withRpcPage } from './session.mjs';
import { readAllProjectItems } from './pull.mjs';

export const DESIGN_SYSTEM_TYPE = 'PROJECT_TYPE_DESIGN_SYSTEM';
// ListProjects answers 20 items per page with a numeric-string `cursor` (absent on the last
// page) and ignores type/pageSize filters, so a design system that has not been opened recently
// sits on a later page and only paging finds it.
const AUTH_ERROR_RE = /HTTP (?:401|403)\b/;

export function designSystemView(project) {
  const view = { name: String(project?.name ?? ''), id: String(project?.projectId ?? '') };
  if (project?.publishedAt) view.publishedAt = project.publishedAt;
  if (project?.viewedAt) view.viewedAt = project.viewedAt;
  return view;
}

export function designSystemsOf(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.type === DESIGN_SYSTEM_TYPE)
    .map(designSystemView);
}

export async function listDesignSystems(deps = {}) {
  const openSession = deps.ensureSession || ensureSession;
  const onPage = deps.withRpcPage || withRpcPage;
  const callOmelette = deps.callOmelette || omelette;
  const session = await openSession({ visible: false });
  return onPage(session, async (page) => {
    try {
      return designSystemsOf(await readAllProjectItems({ ...session, page }, callOmelette));
    } catch (error) {
      // A cookie that lapses between the session probe and this call surfaces as a 401/403 here;
      // re-raise it as the same login guidance every other tool gives.
      if (!AUTH_ERROR_RE.test(error?.message || '')) throw error;
      throw new NotLoggedInError(loginHelp(error.message));
    }
  });
}
