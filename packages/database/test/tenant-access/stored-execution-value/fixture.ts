export function canonicalJsonOracle(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((child) => canonicalJsonOracle(child)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonOracle((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

export function seededJsonCases(seed: number, count: number): unknown[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const create = (depth: number): unknown => {
    const kind = depth === 0 ? next() % 4 : next() % 6;
    if (kind === 0) return null;
    if (kind === 1) return (next() & 1) === 1;
    if (kind === 2) return (next() % 20_001) - 10_000;
    if (kind === 3) return `value-${String(next())}-界`;
    const size = next() % 4;
    if (kind === 4)
      return Array.from({ length: size }, () => create(depth - 1));
    return Object.fromEntries(
      Array.from({ length: size }, (_, index) => [
        `key-${String(index)}-${String(next() % 7)}`,
        create(depth - 1),
      ]),
    );
  };
  return Array.from({ length: count }, () => create(3));
}
