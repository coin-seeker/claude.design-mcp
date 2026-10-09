export function designBackend() {
  const value = (process.env.CLAUDE_DESIGN_BACKEND || '').trim().toLowerCase();
  switch (value) {
    case '':
    case 'artifacts': return 'artifacts';
    case 'standalone': return 'standalone';
    default: throw new Error(`Invalid CLAUDE_DESIGN_BACKEND "${value}": expected artifacts | standalone`);
  }
}

export function homeUrl() {
  return designBackend() === 'artifacts' ? 'https://claude.ai/artifacts/design' : 'https://claude.ai/design';
}
