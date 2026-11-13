import { formatByteLength } from '@/lib/format/bytes';
import { formatCount } from '@/lib/format/count';

/** "4 fields · 312 B": what a value holds, before anyone opens it. */
export function describeValue(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  let shape: string;
  if (Array.isArray(value)) shape = formatCount(value.length, 'item');
  else if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value).length;
    shape = formatCount(fields, 'field');
  } else shape = value === null ? 'null' : typeof value;
  return `${shape} · ${formatByteLength(bytes)}`;
}

/** `{}` or `[]`: a value with nothing in it, which reads as "nothing". */
export function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.keys(value).length === 0
  );
}
