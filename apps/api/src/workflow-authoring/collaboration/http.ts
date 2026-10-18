import { z } from 'zod';
import { workflowIdParamSchema } from '@pertexo/contracts';
import { WorkflowCollaborationError } from '@pertexo/database/authoring';
import {
  applicationError,
  throwApplicationError,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { throwWorkflowApplicationError } from '../errors.js';
export const discussionParamsSchema = workflowIdParamSchema
  .extend({ threadId: z.uuid() })
  .strict();
export const commentParamsSchema = discussionParamsSchema
  .extend({ commentId: z.uuid() })
  .strict();
export const presenceParamsSchema = workflowIdParamSchema
  .extend({ tabId: z.uuid() })
  .strict();
export async function collaborationOperation<
  Route extends { workspaceId: string },
  T,
>(
  request: WorkflowAuthoringRequest,
  params: unknown,
  schema: z.ZodType<Route>,
  operation: (
    scope: ReturnType<typeof projectAuthenticatedWorkspaceContext> & {
      routeWorkspaceId: string;
      signal: AbortSignal;
    },
    route: Route,
  ) => Promise<T>,
) {
  try {
    const route = schema.parse(params);
    const workspaceId = route.workspaceId;
    return await withRequestOperationSignal(request, (signal) =>
      operation(
        {
          ...projectAuthenticatedWorkspaceContext(request, workspaceId),
          routeWorkspaceId: workspaceId,
          signal,
        },
        route,
      ),
    );
  } catch (error) {
    if (error instanceof WorkflowCollaborationError)
      return throwApplicationError(
        applicationError(
          error.reason === 'unavailable'
            ? 'resource.not_found'
            : error.reason === 'forbidden'
              ? 'auth.forbidden'
              : 'workflow.collaboration_conflict',
          { safeDetail: error.message },
        ),
      );
    if (error instanceof z.ZodError)
      return throwApplicationError(
        applicationError('request.invalid', {
          safeDetail:
            'The discussion or presence request is invalid. Check its fields and limits.',
        }),
      );
    return throwWorkflowApplicationError(error);
  }
}
