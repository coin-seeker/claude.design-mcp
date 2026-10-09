import { frameRequest } from './api.mjs';

const FALLBACK_SLUGS = Object.freeze({
  design: 'bcd2878f-a88d-4094-a616-8e39d8a5fd8a',
  designSystem: '23336be2-ea67-47fa-abc1-ead8c645a326',
});
const cache = new Map();
const READ_DEPS = { frameRequest };

export async function resolveTypeSlugs(scoped, overrides = {}) {
  if (cache.has(scoped.org)) return cache.get(scoped.org);
  const deps = { ...READ_DEPS, ...overrides };
  let slugs = FALLBACK_SLUGS;
  try {
    const response = await deps.frameRequest(scoped, 'GET', '/api/frame/types');
    const types = Array.isArray(response) ? response : response?.types;
    if (Array.isArray(types)) {
      const slugFor = (title, fallback) => types.find((type) => type?.title === title && typeof type.slug === 'string' && type.slug)?.slug || fallback;
      slugs = Object.freeze({
        design: slugFor('Design', FALLBACK_SLUGS.design),
        designSystem: slugFor('Design System', FALLBACK_SLUGS.designSystem),
      });
    }
  } catch (error) {
    // Type discovery is explicitly best-effort; HTTP/auth/network errors use the verified slugs.
    if (!(error instanceof Error)) throw error;
  }
  cache.set(scoped.org, slugs);
  return slugs;
}
