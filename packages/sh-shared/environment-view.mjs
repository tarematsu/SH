export function environmentView(env, overrides = {}) {
  if (!env || (typeof env !== 'object' && typeof env !== 'function')) return env;
  const entries = Object.entries(overrides)
    .filter(([name, value]) => name && value !== undefined);
  if (!entries.length) return env;

  const view = Object.create(env);
  for (const [name, value] of entries) {
    Object.defineProperty(view, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: false,
    });
  }
  return view;
}
