export function requestWithParsedJson(request, body) {
  return new Proxy(request, {
    get(target, property) {
      if (property === 'json') return async () => body;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
