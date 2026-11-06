export function freezeExecutable<T extends object>(value: T): T {
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const children = Object.values(current) as unknown[];
    for (const child of children)
      if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(current);
  }
  return value;
}
