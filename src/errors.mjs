export function isDomTransitionError(error) {
  const message = error?.message || '';
  return /locator|selector|element|detached|re-render/i.test(message)
    && !/(closed|disconnected|Target)/i.test(message);
}

export function isPageError(error) {
  return /(closed|disconnected|Target)/i.test(error?.message || '');
}

export function isRendererLossError(error) {
  const message = error?.message || '';
  return /Target (page, context or browser has been closed|closed)/i.test(message)
    || /browser has been disconnected/i.test(message)
    || /Page crashed/i.test(message)
    || /Target crashed/i.test(message);
}
