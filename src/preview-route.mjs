import { canonicalMapKey, canonicalRequestPath, resolveAsset } from './preview-assets.mjs';

const PREVIEW_ORIGIN = 'http://claude-design-preview.localhost';
const FATAL_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'script']);

function requestedPath(url) {
  try {
    return canonicalRequestPath(new URL(url).pathname);
  } catch {
    return String(url);
  }
}

function isFatalMiss(request, url) {
  if (FATAL_RESOURCE_TYPES.has(request.resourceType())) return true;
  return /\.(?:css|js|mjs|html?)$/i.test(requestedPath(url));
}

export function missingAssetsError(paths) {
  return new Error(`design_preview: missing referenced project assets: ${[...paths].join(', ')}`);
}

export function encodedProjectUrl(targetPath) {
  const encoded = String(targetPath).split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${PREVIEW_ORIGIN}/${encoded}`;
}

export function createPreviewRoute({ assets, targetPath, targetUrl, page, fatalMissing, missingAssets }) {
  return async (route) => {
    const request = route.request();
    const url = request.url();
    const mainFrame = page() && request.frame() === page().mainFrame();
    if (request.isNavigationRequest() && mainFrame && url === targetUrl) {
      const target = assets.get(canonicalMapKey(targetPath));
      if (target) await route.fulfill({ body: target.bytes, contentType: target.contentType, status: 200 });
      else {
        fatalMissing.add(canonicalMapKey(targetPath));
        await route.fulfill({ status: 404, body: Buffer.alloc(0) });
      }
      return;
    }
    if (url.startsWith(`${PREVIEW_ORIGIN}/`)) {
      const asset = resolveAsset(assets, new URL(url).pathname);
      if (asset) await route.fulfill({ body: asset.bytes, contentType: asset.contentType, status: 200 });
      else {
        const requested = requestedPath(url);
        if (isFatalMiss(request, url)) fatalMissing.add(requested);
        else missingAssets.add(requested);
        await route.fulfill({ status: 404, body: Buffer.alloc(0) });
      }
      return;
    }
    if (request.isNavigationRequest() && mainFrame) await route.abort();
    else await route.continue();
  };
}
