/** A deep copy whose objects and arrays are all frozen. */
export function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (const item of value) copy.push(cloneAndFreeze(item));
    return Object.freeze(copy) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: cloneAndFreeze(item),
      writable: true,
    });
  return Object.freeze(copy) as T;
}
