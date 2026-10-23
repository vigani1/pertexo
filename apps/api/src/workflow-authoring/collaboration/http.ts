import { z } from 'zod';
import { workflowIdParamSchema } from '@pertexo/contracts';

import { withRequestOperationSignal } from '../../platform/http/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type { WorkflowAuthoringRequest } from '../types.js';

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
}
