import path from 'node:path';

import { decodeToBuffer, fileEntriesOf } from './helpers.mjs';

const FETCH_CONCURRENCY = 4;
const MAX_FILE_COUNT = 300;
const MAX_DECODED_BYTES = 100 * 1024 * 1024;

const CONTENT_TYPES = new Map([
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
]);

function canonicalSegments(input, decode) {
  const parts = [];
  for (const rawSegment of String(input ?? '').split('/')) {
    let segment = rawSegment;
    if (decode) {
      try {
        segment = decodeURIComponent(rawSegment);
      } catch {
        segment = rawSegment;
      }
    }
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error(`design_preview: parent path segment ".." rejected in ${input}`);
    parts.push(segment);
  }
  return parts.join('/').normalize('NFC');
}

export function canonicalMapKey(rawPath) {
  return canonicalSegments(rawPath, false);
}

export function canonicalRequestPath(urlPathname) {
  return canonicalSegments(urlPathname, true);
}

export function resolveAsset(map, urlPathname) {
  // Deterministic precedence: literal, undecoded pathname first, then exactly-once decoded pathname.
  // This lets raw `a%23b.css` and `a#b.css` coexist without the decoded form shadowing the literal one.
  const exact = map.get(canonicalMapKey(urlPathname));
  if (exact !== undefined) return exact;
  return map.get(canonicalRequestPath(urlPathname));
}

export function assetContentType(entryContentType, filePath) {
  if (entryContentType) return entryContentType;
  return CONTENT_TYPES.get(path.extname(String(filePath)).toLowerCase()) || 'application/octet-stream';
}

function createParallelPool(limit, getStopError) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const stopError = getStopError();
    if (stopError) {
      for (const queued of queue.splice(0)) queued.reject(stopError);
      return;
    }
    const queued = queue.shift();
    if (queued) queued.run();
  };
  return (job) => new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve().then(() => {
        const stopError = getStopError();
        if (stopError) throw stopError;
        return job();
      }).then(resolve, reject).finally(release);
    };
    if (active < limit) run();
    else queue.push({ run, reject });
  });
}

function cancellationError(stage) {
  return new Error(`design_preview: ${stage} cancelled or deadline exceeded`);
}

export async function fetchProjectAssets(session, projectId, entries, deps) {
  void session;
  const targets = entries.filter((entry) => entry.type !== 'directory' && entry.path);
  if (targets.length > MAX_FILE_COUNT) {
    throw new Error(`design_preview: project has ${targets.length} files, exceeding the 300-file preview limit`);
  }

  const prepared = [];
  const rawPathByKey = new Map();
  for (const entry of targets) {
    const rawPath = entry.path;
    const key = canonicalMapKey(rawPath);
    const previous = rawPathByKey.get(key);
    if (previous !== undefined) {
      throw new Error(`design_preview: canonical asset path collision: "${previous}" and "${rawPath}" both map to "${key}"`);
    }
    rawPathByKey.set(key, rawPath);
    prepared.push({ key, rawPath });
  }

  const cancelError = cancellationError('asset fetch');
  const required = deps.options?.required;
  const requiredKey = required ? canonicalMapKey(required) : null;
  let fatalError = null;
  let rejectFatal;
  const fatalSignal = new Promise((_, reject) => { rejectFatal = reject; });
  let decodedBytes = 0;
  const latchFatal = (error) => {
    if (!fatalError) {
      fatalError = error;
      rejectFatal(error);
    }
    return fatalError;
  };
  const getStopError = () => fatalError || (deps.cancel.cancelled ? cancelError : null);
  const acquire = createParallelPool(FETCH_CONCURRENCY, getStopError);

  const jobs = prepared.map(({ key, rawPath }) => acquire(async () => {
    const remaining = deps.remaining();
    if (remaining < 1) throw latchFatal(cancellationError('asset fetch'));

    let file;
    try {
      file = await deps.getFile(projectId, rawPath, Math.min(30_000, remaining));
    } catch (error) {
      if (deps.cancel.cancelled) throw cancelError;
      if (key === requiredKey) throw latchFatal(error);
      return { fetchError: { path: rawPath, error } };
    }

    const stopError = getStopError();
    if (stopError) throw stopError;
    const bytes = decodeToBuffer(file.content || '');
    decodedBytes += bytes.length;
    if (decodedBytes > MAX_DECODED_BYTES) {
      throw latchFatal(new Error('design_preview: project assets exceed the 100 MiB decoded preview limit'));
    }
    return {
      key,
      asset: {
        bytes,
        contentType: assetContentType(file.contentType, rawPath),
        rawPath,
      },
    };
  }));

  const completion = Promise.allSettled(jobs);
  const settled = await Promise.race([completion, fatalSignal]);
  if (fatalError) throw fatalError;
  if (deps.cancel.cancelled) throw cancelError;
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;

  const assets = new Map();
  const fetchErrors = [];
  for (const result of settled) {
    const value = result.value;
    if (value.fetchError) fetchErrors.push(value.fetchError);
    else assets.set(value.key, value.asset);
  }
  return { assets, fetchErrors };
}

export async function listProjectFilesComplete(session, projectId, deps) {
  void session;
  const entries = [];
  let total = 0;
  for (let guard = 0; guard < 50; guard += 1) {
    const remaining = deps.remaining();
    if (deps.cancel.cancelled || remaining < 1) throw cancellationError('file listing');
    const page = await deps.listPage(projectId, entries.length, Math.min(30_000, remaining));
    if (deps.cancel.cancelled || deps.remaining() < 1) throw cancellationError('file listing');
    const pageEntries = fileEntriesOf(page);
    entries.push(...pageEntries);
    total = Number(page.total ?? total ?? entries.length);
    if (!pageEntries.length || entries.length >= total) break;
  }
  if (entries.length < total) {
    throw new Error(`design_preview: file listing incomplete (${entries.length}/${total})`);
  }
  return entries;
}
