import { z } from 'zod';
import { singleRequestHeader } from '../../platform/http/request-headers.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';

import type { WorkflowAuthoringRequest } from '../types.js';

export function requestContext(
  request: WorkflowAuthoringRequest,
  workspaceId: string,
) {
  return projectAuthenticatedWorkspaceContext(request, workspaceId);
}

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));

export function traceparent(
  request: WorkflowAuthoringRequest,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined
    ? {}
    : { traceparent: traceparentSchema.parse(value) };
}
