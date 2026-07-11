export function combinedAbortSignal(existingSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!existingSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([existingSignal, timeoutSignal]);
  }
  return existingSignal;
}
