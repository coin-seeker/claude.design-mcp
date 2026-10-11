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

export function validateClip(clip) {
  if (clip === undefined) return undefined;
  const invalid = () => new Error('design_preview: clip must be {x,y,width,height} with finite CSS-pixel numbers, x/y >= 0, width/height > 0, bounds <= 10000w/20000h and area <= 40M pixels');
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) throw invalid();
  const { x, y, width, height } = clip;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0
    || x + width > MAX_CAPTURE_WIDTH || y + height > MAX_CAPTURE_HEIGHT || width * height > MAX_CAPTURE_PIXELS) throw invalid();
  return { x, y, width, height };
}

export function capturePlan(pageSize, viewportSize, requestedClip) {
  const clip = validateClip(requestedClip);
  if (clip) return { fullPage: false, clip, capturedSize: { width: clip.width, height: clip.height }, truncated: false };
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
