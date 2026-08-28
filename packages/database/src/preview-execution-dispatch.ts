import type { Pool } from 'pg';
import { z } from 'zod';

import {
  PreviewAttemptStateError,
  optionsFor,
  type PreviewAttemptLease,
} from './preview-execution-contract.js';
import { withTenantScopedClient } from './workspace.js';

export async function markPreviewDispatched(
  pool: Pool,
  input: Readonly<{
    lease: Pick<
      PreviewAttemptLease,
      'attemptFenceToken' | 'previewAttemptId' | 'previewRunId' | 'workspaceId'
    >;
    connectionFence?: Readonly<{
      connectionId: string;
      expectedProviderKey: string;
      expectedAuthType: string;
      secretVersionId: string;
    }>;
    providerDispatchBinding?: string;
    signal?: AbortSignal;
    workerId: string;
  }>,
): Promise<'committed'> {
  const scope = z
    .object({
      attemptFenceToken: z.number().int().nonnegative(),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      connectionFence: z
        .object({
          connectionId: z.uuid(),
          expectedProviderKey: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
          expectedAuthType: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
          secretVersionId: z.uuid(),
        })
        .strict()
        .optional(),
      providerDispatchBinding: z
        .string()
        .max(128)
        .regex(/^[a-z][a-z0-9._-]{0,31}:v[1-9][0-9]{0,2}:sha256:[0-9a-f]{64}$/u)
        .optional(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse({
      ...input.lease,
      ...(input.connectionFence === undefined
        ? {}
        : { connectionFence: input.connectionFence }),
      ...(input.providerDispatchBinding === undefined
        ? {}
        : { providerDispatchBinding: input.providerDispatchBinding }),
      workerId: input.workerId,
    });
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client) => {
      if (scope.connectionFence !== undefined) {
        const fencedConnection = await client.query<{
          fence_current: boolean;
        }>(
          `select app.connection_dispatch_fence_current(
             $1,$2,$3,$4,$5
           ) fence_current`,
          [
            scope.workspaceId,
            scope.connectionFence.connectionId,
            scope.connectionFence.expectedProviderKey,
            scope.connectionFence.expectedAuthType,
            scope.connectionFence.secretVersionId,
          ],
        );
        if (fencedConnection.rows[0]?.fence_current !== true)
          throw new PreviewAttemptStateError('connection_fence_failed');
      }
      const locked = await client.query<{
        provider_dispatch_binding: string | null;
      }>(
        `select provider_dispatch_binding from app.preview_attempts
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running' and lease_owner=$4 and fence_token=$5
         for update`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          scope.workerId,
          scope.attemptFenceToken,
        ],
      );
      const existingBinding = locked.rows[0]?.provider_dispatch_binding;
      if (existingBinding === undefined)
        throw new PreviewAttemptStateError('dispatch_marker_lost');
      if (
        scope.providerDispatchBinding !== undefined &&
        existingBinding !== null &&
        existingBinding !== scope.providerDispatchBinding
      )
        throw new PreviewAttemptStateError('dispatch_binding_mismatch');
      const result = await client.query(
        `update app.preview_attempts
         set dispatch_marked_at=coalesce(dispatch_marked_at, clock_timestamp()),
             provider_dispatch_binding=coalesce(provider_dispatch_binding,$6),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running'
           and lease_owner=$4 and fence_token=$5`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          scope.workerId,
          scope.attemptFenceToken,
          scope.providerDispatchBinding ?? null,
        ],
      );
      if (result.rowCount !== 1)
        throw new PreviewAttemptStateError('dispatch_marker_lost');
      return 'committed' as const;
    },
    optionsFor(input.signal),
  );
}
