export function isDomTransitionError(error) {
  const message = error?.message || '';
  return /locator|selector|element|detached|re-render/i.test(message)
    && !/(closed|disconnected|Target)/i.test(message);
}

export function isPageError(error) {
  return /(closed|disconnected|Target)/i.test(error?.message || '');
}
