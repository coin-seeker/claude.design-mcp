const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const VIEWPORT_LIMITS = {
  width: { min: 320, max: 3840 },
  height: { min: 240, max: 2160 },
};
const MAX_CAPTURE_WIDTH = 10_000;
const MAX_CAPTURE_HEIGHT = 20_000;
const MAX_CAPTURE_PIXELS = 40_000_000;

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function capturePlan(pageSize, viewportSize) {
  const viewport = normalizeViewport(viewportSize);
  const pageWidth = positiveInteger(pageSize?.width, viewport.width);
  const pageHeight = positiveInteger(pageSize?.height, viewport.height);
  let height = Math.min(pageHeight, MAX_CAPTURE_HEIGHT);
  const width = Math.min(pageWidth, MAX_CAPTURE_WIDTH);

  if (width * height > MAX_CAPTURE_PIXELS) {
    height = Math.floor(MAX_CAPTURE_PIXELS / width);
  }

  const capturedSize = { width, height };
  const truncated = width !== pageWidth || height !== pageHeight;
  if (!truncated) {
    return { fullPage: true, clip: null, capturedSize, truncated: false };
  }

  return {
    fullPage: false,
    clip: { x: 0, y: 0, width, height },
    capturedSize,
    truncated: true,
  };
}

export function normalizeViewport({ width, height } = {}) {
  const normalizedWidth = positiveInteger(width, DEFAULT_VIEWPORT.width);
  const normalizedHeight = positiveInteger(height, DEFAULT_VIEWPORT.height);
  return {
    width: Math.max(VIEWPORT_LIMITS.width.min, Math.min(VIEWPORT_LIMITS.width.max, normalizedWidth)),
    height: Math.max(VIEWPORT_LIMITS.height.min, Math.min(VIEWPORT_LIMITS.height.max, normalizedHeight)),
  };
}
