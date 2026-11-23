import { isRecord } from '@pertexo/workflow-model';

export function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
      const items: readonly unknown[] = current;
      current = items[Number(key)];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}
