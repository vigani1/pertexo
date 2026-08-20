import { randomUUID } from 'node:crypto';

import { parseRequestId } from '../platform/http/index.js';
import type { IdentityWorkspaceRequest } from './types.js';

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/iu;

export function requestIdentifier(request: IdentityWorkspaceRequest): string {
  return (
    parseRequestId(request.requestId) ??
    parseRequestId(header(request, 'x-request-id')) ??
    randomUUID()
  );
}

export function traceIdentifier(
  request: IdentityWorkspaceRequest,
): string | undefined {
  const value = request.traceId ?? header(request, 'traceparent');
  const match =
    value === undefined ? undefined : traceparentPattern.exec(value);
  if (match !== null && match !== undefined) return match[1];
  return value === undefined ? undefined : parseRequestId(value);
}

function header(
  request: IdentityWorkspaceRequest,
  name: string,
): string | undefined {
  const headers = request.headers;
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  const value = key === undefined ? undefined : headers[key];
  return typeof value === 'string' ? value : value?.[0];
}
