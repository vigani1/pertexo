import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { previewAttempts } from '@pertexo/database/schema';

import { isConnectionFenceCurrent } from '../../connections/runtime/credential-use.repository.js';
import type { PreviewAttemptLease } from '../contract.js';
import { PreviewAttemptStateError } from '../errors.js';
import { optionsFor } from '../input.js';

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
      const db = drizzle(client);
      const ownsLiveLease = and(
        eq(previewAttempts.workspaceId, scope.workspaceId),
        eq(previewAttempts.id, scope.previewAttemptId),
        eq(previewAttempts.previewRunId, scope.previewRunId),
        eq(previewAttempts.status, 'running'),
        eq(previewAttempts.leaseOwner, scope.workerId),
        eq(previewAttempts.fenceToken, scope.attemptFenceToken),
        sql`${previewAttempts.leaseExpiresAt}>clock_timestamp()`,
      );
      const locked = await db
        .select({
          providerDispatchBinding: previewAttempts.providerDispatchBinding,
        })
        .from(previewAttempts)
        .where(ownsLiveLease)
        .for('update')
        .catch(rethrowQueryFailure);
      const existingBinding = locked[0]?.providerDispatchBinding;
      if (existingBinding === undefined)
        throw new PreviewAttemptStateError('dispatch_marker_lost');
      const dispatchBindingChanged =
        scope.providerDispatchBinding !== undefined &&
        existingBinding !== null &&
        existingBinding !== scope.providerDispatchBinding;
      if (dispatchBindingChanged)
        throw new PreviewAttemptStateError('dispatch_binding_mismatch');
      const result = await db
        .update(previewAttempts)
        .set({
          dispatchMarkedAt: sql`coalesce(${previewAttempts.dispatchMarkedAt},clock_timestamp())`,
          providerDispatchBinding: sql`coalesce(${previewAttempts.providerDispatchBinding},${scope.providerDispatchBinding ?? null})`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownsLiveLease)
        .returning({ id: previewAttempts.id })
        .catch(rethrowQueryFailure);
      if (result.length !== 1)
        throw new PreviewAttemptStateError('dispatch_marker_lost');
      return 'committed' as const;
    },
    optionsFor(input.signal),
  );
}
