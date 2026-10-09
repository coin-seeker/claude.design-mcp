export function text(value) {
  return typeof value === 'string' && value ? value : null;
}

export function flag(value) {
  return typeof value === 'boolean' ? value : null;
}

export function firstText(...values) {
  for (const value of values) {
    const found = text(value);
    if (found !== null) return found;
  }
  return null;
}
