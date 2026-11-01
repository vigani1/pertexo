import {
  parseApiTokenCredential,
  type ParsedApiTokenCredential,
} from '@pertexo/core/tenant-access';
import type { RequestHeaders } from '../../platform/http/request-headers.js';

export type AuthorizationHeaderSource = Readonly<{
  raw?: Readonly<{ rawHeaders?: readonly string[] }>;
}>;

function originalAuthorizationValues(rawHeaders: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2)
    if (rawHeaders[index]?.toLowerCase() === 'authorization')
      values.push(rawHeaders[index + 1] ?? '');
  return values;
}

export function hasAuthorizationHeader(
  headers: RequestHeaders,
  rawHeaders?: readonly string[],
): boolean {
  return (
    (rawHeaders !== undefined &&
      originalAuthorizationValues(rawHeaders).length > 0) ||
    Object.keys(headers ?? {}).some(
      (name) => name.toLowerCase() === 'authorization',
    )
  );
}
/** Refuse ambiguous headers before any workspace-scoped credential lookup. */
export function bearerCredential(
  headers: RequestHeaders,
  rawHeaders?: readonly string[],
): ParsedApiTokenCredential | undefined {
  const entries = Object.entries(headers ?? {}).filter(
    ([name]) => name.toLowerCase() === 'authorization',
  );
  if (entries.length !== 1) return undefined;
  // Node discards repeated Authorization values in its normalized headers.
  if (
    rawHeaders !== undefined &&
    originalAuthorizationValues(rawHeaders).length !== 1
  )
    return undefined;
  const raw = entries[0]?.[1];
  let value: string | undefined;
  if (typeof raw === 'string') value = raw;
  else if (raw?.length === 1) value = raw[0];
  if (value === undefined || !/^Bearer /iu.test(value)) return undefined;
  return parseApiTokenCredential(value.slice(7));
}
