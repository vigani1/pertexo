import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import type { WorkflowOrganizationInput } from './authority.js';

import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import {
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

/** Shared scoped cancellation/error translation, never manual HTTP formatting. */
export async function withWorkflowOrganizationRequest<T>(
  request: WorkflowAuthoringRequest,
  caller: WorkspaceCaller,
  work: (input: WorkflowOrganizationInput) => Promise<T>,
): Promise<T> {
  return await withRequestOperationSignal(request, (signal) =>
    work({
      ...serviceCaller(caller),
      signal,
    }),
  );
}
