import { sanitizeName } from './helpers.mjs';
import { resolveOptionalModel } from './model.mjs';

const VARIANTS_MAX_COUNT = 4;
const VARIANTS_MAX_CONCURRENCY = 3;
const AXIS_HINTS = {
  layout: 'Vary the LAYOUT: use a distinctly different page structure, grid, and content arrangement from the other variants.',
  color: 'Vary the COLOR: use a distinctly different color palette and contrast strategy from the other variants.',
  typography: 'Vary the TYPOGRAPHY: use distinctly different typefaces, type scale, and text rhythm from the other variants.',
  mood: 'Vary the MOOD: use a distinctly different overall feel and visual tone from the other variants.',
};

function requirePrompt(value) {
  const prompt = String(value ?? '').trim();
  if (!prompt) throw new Error('prompt is required');
  return prompt;
}

export function variantPrompt(prompt, axis, index, count) {
  const hint = AXIS_HINTS[axis] || (axis ? `Vary along this axis: ${axis}.` : 'Use a clearly different mood, layout, and palette from the other variants.');
  return `${prompt}\n\nThis is variant ${index + 1} of ${count}. ${hint}`;
}

export function createPool(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const run = queue.shift();
    if (run) run();
  };
  return (job) => new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve().then(job).then(resolve, reject).finally(release);
    };
    if (active < limit) run();
    else queue.push(run);
  });
}

export async function generateVariants(args, deps) {
  const prompt = requirePrompt(args.prompt);
  const modelRequest = resolveOptionalModel(args.model);
  const model = `${modelRequest.family}${modelRequest.version ? `-${modelRequest.version}` : ''}`;
  const count = Math.max(1, Math.min(VARIANTS_MAX_COUNT, Number(args.count) || 3));
  const axis = args.axis ? String(args.axis) : null;
  const withPreview = args.preview !== false;
  const acquire = createPool(deps.concurrency || VARIANTS_MAX_CONCURRENCY);
  const baseName = sanitizeName(args.name || String(prompt).replace(/\s+/g, ' ').slice(0, 64));
  const variants = await Promise.all(Array.from({ length: count }, (_, index) => acquire(async () => {
    try {
      const created = await deps.create({ prompt: variantPrompt(prompt, axis, index, count), name: `${baseName}-v${index + 1}`, timeoutMs: args.timeoutMs, model, designSystem: args.designSystem });
      if (!withPreview) return { index, ...created, image: null };
      try {
        const shot = await deps.preview({ projectId: created.projectId });
        return { index, ...created, image: shot.image || null };
      } catch (error) {
        return { index, ...created, image: null, previewError: String(error?.message || error) };
      }
    } catch (error) {
      return { index, error: String(error?.message || error) };
    }
  })));
  return { prompt, axis, count, variants };
}
