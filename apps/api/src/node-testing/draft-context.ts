import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import {
  serviceCaller,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

export type DraftRequest = IdentityWorkspaceRequest & AbortableRequest;

/** Who is asking, about which workflow's draft. */
export function draftContext(
  caller: WorkspaceCaller,
  { workflowId }: Readonly<{ workflowId: string }>,
) {
  return {
    ...serviceCaller(caller),
    workflowId,
  };
}
