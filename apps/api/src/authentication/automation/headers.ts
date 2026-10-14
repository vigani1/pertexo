import {
  parseApiTokenCredential,
  type ParsedApiTokenCredential,
} from '@pertexo/database/tenant-access';
import type { RequestHeaders } from '../../platform/http/request-headers.js';

export function hasAuthorizationHeader(headers: RequestHeaders): boolean {
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === 'authorization',
  );
}
/** Refuse ambiguous headers before any workspace-scoped credential lookup. */
export function bearerCredential(
  headers: RequestHeaders,
): ParsedApiTokenCredential | undefined {
  const entries = Object.entries(headers ?? {}).filter(
    ([name]) => name.toLowerCase() === 'authorization',
  );
  if (entries.length !== 1) return undefined;
  const raw = entries[0]?.[1];
  const value =
    typeof raw === 'string' ? raw : raw?.length === 1 ? raw[0] : undefined;
  if (value === undefined || !/^Bearer /iu.test(value)) return undefined;
  return parseApiTokenCredential(value.slice(7));
}
