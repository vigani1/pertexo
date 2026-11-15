import {
  parseApiTokenCredential,
  type ParsedApiTokenCredential,
} from '@pertexo/core/tenant-access';
import type { RequestHeaders } from '../../platform/http/request-headers.js';
import { rawHeaderValues } from '../../platform/http/raw-headers.js';

const BEARER_PREFIX = 'Bearer ';

export type AuthorizationHeaderSource = Readonly<{
  raw?: Readonly<{ rawHeaders?: readonly string[] }>;
}>;

function originalAuthorizationValues(rawHeaders: readonly string[]): string[] {
  return rawHeaderValues(rawHeaders, 'authorization');
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
  if (value === undefined || !new RegExp(`^${BEARER_PREFIX}`, 'iu').test(value))
    return undefined;
  return parseApiTokenCredential(value.slice(BEARER_PREFIX.length));
}
