import { lockWorkspaceRunAdmission } from '../../shared/workspace-fence.repository.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { withTenantScopedClient } from '@pertexo/database/primitives';

import { isConnectionFenceCurrent } from '../../connections/runtime/credential-use.repository.js';
import { PreviewAttemptStateError } from '../preview.errors.js';
import type { MarkPreviewDispatchedInput } from './preview-attempt.types.js';
import {
  lockPreviewDispatchBinding,
  markPreviewDispatch,
} from './dispatch-marks.repository.js';

export async function markPreviewDispatched(
  pool: Pool,
  input: MarkPreviewDispatchedInput,
): Promise<'committed'> {
  const scope = {
    ...input.lease,
    ...(input.connectionFence === undefined
      ? {}
      : { connectionFence: input.connectionFence }),
    ...(input.providerDispatchBinding === undefined
      ? {}
      : { providerDispatchBinding: input.providerDispatchBinding }),
    workerId: input.workerId,
  };
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client) => {
      const workspaceStatus = await lockWorkspaceRunAdmission(
        drizzle(client),
        scope.workspaceId,
      );
      if (scope.connectionFence !== undefined) {
        const current = await isConnectionFenceCurrent(
          client,
          scope.workspaceId,
          {
            connectionId: scope.connectionFence.connectionId,
            providerKey: scope.connectionFence.expectedProviderKey,
            authType: scope.connectionFence.expectedAuthType,
            secretVersionId: scope.connectionFence.secretVersionId,
          },
        );
        if (!current)
          throw new PreviewAttemptStateError('connection_fence_failed');
      }
      if (workspaceStatus !== 'active')
        throw new PreviewAttemptStateError('workspace_unavailable');
      const existingBinding = await lockPreviewDispatchBinding(client, scope);
      if (existingBinding === undefined)
        throw new PreviewAttemptStateError('dispatch_marker_lost');
      const dispatchBindingChanged =
        scope.providerDispatchBinding !== undefined &&
        existingBinding !== null &&
        existingBinding !== scope.providerDispatchBinding;
      if (dispatchBindingChanged)
        throw new PreviewAttemptStateError('dispatch_binding_mismatch');
      if (
        !(await markPreviewDispatch(
          client,
          scope,
          scope.providerDispatchBinding,
        ))
      )
        throw new PreviewAttemptStateError('dispatch_marker_lost');
      return 'committed' as const;
    },
    input,
  );
}
