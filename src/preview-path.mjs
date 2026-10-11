import { createHash } from 'node:crypto';
import { sanitizeName } from './helpers.mjs';

export function splitPreviewPath(value) {
  if (value === undefined || value === null) return { path: value, suffix: '' };
  const text = String(value).normalize('NFC');
  const index = text.search(/[?#]/);
  return index < 0 ? { path: text, suffix: '' } : { path: text.slice(0, index), suffix: text.slice(index) };
}

export function previewFilename(targetPath, suffix = '') {
  const base = sanitizeName(String(targetPath).normalize('NFC').replace(/[\\/]+/g, '-'));
  // Keep suffixes readable, but distinguish punctuation and long suffixes after sanitization.
  const tag = suffix ? `-${sanitizeName(suffix.replace(/[?#]/g, '-')).slice(0, 48)}-${createHash('sha256').update(suffix).digest('hex').slice(0, 12)}` : '';
  return `${base}${tag}.png`.normalize('NFC');
}
