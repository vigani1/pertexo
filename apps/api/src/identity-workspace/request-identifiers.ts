import { randomUUID } from 'node:crypto';

import { parseRequestId } from '../platform/http/index.js';
import { firstRequestHeader } from '../platform/http/request-headers.js';
import type { IdentityWorkspaceRequest } from './types.js';

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/iu;

export function requestIdentifier(request: IdentityWorkspaceRequest): string {
  return (
    parseRequestId(request.requestId) ??
    parseRequestId(firstRequestHeader(request.headers, 'x-request-id')) ??
    randomUUID()
  );
}

export function traceIdentifier(
  request: IdentityWorkspaceRequest,
): string | undefined {
  const value =
    request.traceId ?? firstRequestHeader(request.headers, 'traceparent');
  const match =
    value === undefined ? undefined : traceparentPattern.exec(value);
  if (match !== null && match !== undefined) return match[1];
  return value === undefined ? undefined : parseRequestId(value);
}
