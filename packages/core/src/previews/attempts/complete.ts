import { lockWorkspaceRunAdmission } from '../../shared/access/workspace-fence.repository.js';
import {
  storedAttemptDiagnostics,
  type AttemptDiagnostics,
} from '@pertexo/node-sdk';
import {
  canonicalPreviewOutcome,
  sameStoredCompletion,
  type CanonicalCompletionOutcome,
} from './outcome.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import type {
  CompletePreviewAttemptInput,
  PreviewCompletionResult,
} from './preview-attempt.types.js';
import { appendPreviewTerminalFacts } from './facts.repository.js';
import {
  lockStoredCompletion,
  syncPreviewRunOutcome,
  writePreviewTerminalAttempt,
} from './outcomes.repository.js';

import type { PreviewDelivery } from '../preview.types.js';
import { previewConsumerName } from '../delivery.js';
import { PreviewAttemptStateError } from '../preview.errors.js';
import {
  auditingDeliveryMismatch,
  completePreviewReceipt,
  readPreviewReceipt,
  validatePreviewDelivery,
} from './deliveries.repository.js';

type PreviewCompletionScope = Readonly<{
  attemptFenceToken: number;
  delivery: PreviewDelivery;
  previewAttemptId: string;
  previewRunId: string;
  workerId: string;
  workspaceId: string;
}>;

async function exactDuplicateCompletion(
  client: PoolClient,
  scope: PreviewCompletionScope,
  {
    outcome,
    receipt,
    diagnostics,
  }: Readonly<{
    outcome: CanonicalCompletionOutcome;
    receipt: 'completed' | 'open';
    diagnostics: AttemptDiagnostics | null;
  }>,
): Promise<PreviewCompletionResult> {
  const row = await lockStoredCompletion(client, scope);
  if (row === undefined || receipt !== 'completed')
    throw new PreviewAttemptStateError('completion_lost');
  if (!sameStoredCompletion(row, outcome, diagnostics))
    throw new PreviewAttemptStateError('completion_lost');
  return Object.freeze({ kind: 'duplicate' });
}

export async function completePreviewAttempt(
  pool: Pool,
  input: CompletePreviewAttemptInput,
): Promise<PreviewCompletionResult> {
  const scope = {
    ...input.lease,
    delivery: input.delivery,
    workerId: input.workerId,
  };
  const diagnostics = storedAttemptDiagnostics(input);
  const outcome = canonicalPreviewOutcome(input.outcome);
  return auditingDeliveryMismatch(
    pool,
    previewConsumerName,
    {
      workspaceId: scope.workspaceId,
      delivery: input.delivery,
      signal: input.signal,
    },
    () =>
      withTenantScopedClient(
        pool,
        { workspaceId: scope.workspaceId },
        async (client): Promise<PreviewCompletionResult> => {
          await lockWorkspaceRunAdmission(drizzle(client), scope.workspaceId);
          await validatePreviewDelivery(client, {
            delivery: input.delivery,
            previewAttemptId: scope.previewAttemptId,
            previewRunId: scope.previewRunId,
            workspaceId: scope.workspaceId,
          });
          const receipt = await readPreviewReceipt(
            client,
            previewConsumerName,
            scope.workspaceId,
            input.delivery,
          );
          const written = await writePreviewTerminalAttempt(client, scope, {
            outcome,
            diagnostics,
          });
          if (!written)
            return exactDuplicateCompletion(client, scope, {
              outcome,
              receipt,
              diagnostics,
            });
          if (receipt !== 'open')
            throw new PreviewAttemptStateError('receipt_already_completed');
          if (!(await syncPreviewRunOutcome(client, scope, outcome)))
            throw new PreviewAttemptStateError('run_sync_lost');
          await appendPreviewTerminalFacts(client, {
            previewAttemptId: scope.previewAttemptId,
            previewRunId: scope.previewRunId,
            status: outcome.status,
            workspaceId: scope.workspaceId,
          });
          // The inbox receipt completes atomically with the truthful business
          // outcome, exactly like production attempt transitions.
          await completePreviewReceipt(
            client,
            previewConsumerName,
            scope.workspaceId,
            {
              outboxEventId: scope.delivery.outboxEventId,
              payloadChecksum: scope.delivery.payloadChecksum,
            },
          );
          return Object.freeze({ kind: 'committed' });
        },
        input,
      ),
  );
}
