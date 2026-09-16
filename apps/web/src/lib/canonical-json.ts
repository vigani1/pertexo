export function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}
