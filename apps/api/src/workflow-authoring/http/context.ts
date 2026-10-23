import { throwApplicationError } from '../../platform/http/application-error.js';

import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { applicationError } from '../../platform/http/index.js';
import { singleRequestHeader } from '../../platform/http/request-headers.js';

import {
  workflowIdParamSchema,
  type WorkflowAuthoringRequest,
} from '../types.js';

const workflowWorkspaceParamSchema = workflowIdParamSchema
  .pick({ workspaceId: true })
  .strict()
  .readonly();

export function workspaceParams(
  value: unknown,
): Readonly<{ workspaceId: string }> {
  return workflowWorkspaceParamSchema.parse(value);
}

export function workflowParams(value: unknown): Readonly<{
  workspaceId: string;
  workflowId: string;
}> {
  return workflowIdParamSchema.parse(value);
}

export function requestContext(
  request: WorkflowAuthoringRequest,
  workspaceId: string,
) {
  try {
    return projectAuthenticatedWorkspaceContext(request, workspaceId);
  } catch (error: unknown) {
    return throwApplicationError(
      applicationError('request.invalid', {
        safeDetail:
          error instanceof Error ? error.message : 'Invalid actor context',
      }),
    );
  }
}

export function traceparent(
  request: WorkflowAuthoringRequest,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined ? {} : { traceparent: value };
}
