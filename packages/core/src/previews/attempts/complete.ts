import type { CodeDiagnostics } from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import {
  rethrowQueryFailure,
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';
import type {
  CompletePreviewAttemptInput,
  PreviewCompletionResult,
} from './contract.js';
import { appendPreviewTerminalFacts } from './facts.repository.js';

import type {
  PreviewDelivery,
  PreviewStatus,
  PreviewTerminalOutcome,
} from '../contract.js';
import { previewConsumerName } from '../delivery.js';
import {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '../errors.js';
import { optionsFor } from '../input.js';
import { PREVIEW_STATUS } from '../state.js';
import {
  auditPreviewDeliveryMismatch,
  completePreviewReceipt,
  readPreviewReceipt,
  validatePreviewDelivery,
} from './deliveries.repository.js';

type CanonicalCompletionOutcome =
  | Readonly<{
      outputRef: string;
      status: typeof PREVIEW_STATUS.succeeded;
    }>
  | Readonly<{
      safeErrorCode: string;
      errorSummary: string | null;
      status: Exclude<PreviewStatus, 'queued' | 'running' | 'succeeded'>;
    }>;

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
    diagnostics: CodeDiagnostics | undefined;
  }>,
): Promise<PreviewCompletionResult> {
  const attempt = alias(previewAttempts, 'attempt');
  const run = alias(previewRuns, 'run');
  const current = await drizzle(client)
    .select({
      codeDiagnostics: attempt.codeDiagnostics,
      errorSummary: attempt.errorSummary,
      attemptStatus: attempt.status,
      attemptOutputRef: attempt.outputRef,
      attemptSafeErrorCode: attempt.safeErrorCode,
      runStatus: run.status,
      runOutputRef: run.outputRef,
      runSafeErrorCode: run.safeErrorCode,
    })
    .from(attempt)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, attempt.workspaceId),
        eq(run.id, attempt.previewRunId),
      ),
    )
    .where(
      and(
        eq(attempt.workspaceId, scope.workspaceId),
        eq(attempt.id, scope.previewAttemptId),
        eq(attempt.previewRunId, scope.previewRunId),
      ),
    )
    .for('update', { of: [attempt, run] })
    .catch(rethrowQueryFailure);
  const row = current[0];
  if (row === undefined || receipt !== 'completed')
    throw new PreviewAttemptStateError('completion_lost');
  const statusesMatch =
    row.attemptStatus === outcome.status && row.runStatus === outcome.status;
  let valuesMatch = false;
  if (outcome.status === PREVIEW_STATUS.succeeded) {
    try {
      valuesMatch =
        serializeStoredExecutionValue(
          parseStoredExecutionValue(row.attemptOutputRef),
        ) === outcome.outputRef &&
        serializeStoredExecutionValue(
          parseStoredExecutionValue(row.runOutputRef),
        ) === outcome.outputRef &&
        row.attemptSafeErrorCode === null &&
        row.runSafeErrorCode === null;
    } catch {
      valuesMatch = false;
    }
  } else {
    valuesMatch =
      row.attemptOutputRef === null &&
      row.runOutputRef === null &&
      row.attemptSafeErrorCode === outcome.safeErrorCode &&
      row.runSafeErrorCode === outcome.safeErrorCode &&
      row.errorSummary === outcome.errorSummary;
  }
  const completionMismatch =
    !statusesMatch ||
    !valuesMatch ||
    canonicalJson(row.codeDiagnostics) !== canonicalJson(diagnostics ?? null);
  if (completionMismatch) throw new PreviewAttemptStateError('completion_lost');
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
  const diagnostics = input.codeDiagnostics;
  const outcome = canonicalPreviewOutcome(input.outcome);
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: scope.workspaceId },
      async (client): Promise<PreviewCompletionResult> => {
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
        const terminal = await writePreviewTerminalAttempt(client, scope, {
          outcome,
          diagnostics,
        });
        if (terminal.length !== 1)
          return exactDuplicateCompletion(client, scope, {
            outcome,
            receipt,
            diagnostics,
          });
        if (receipt !== 'open')
          throw new PreviewAttemptStateError('receipt_already_completed');
        const syncedRuns = await drizzle(client)
          .update(previewRuns)
          .set({
            status: outcome.status,
            outputRef: sql`${outcome.status === PREVIEW_STATUS.succeeded ? outcome.outputRef : null}::json`,
            safeErrorCode:
              outcome.status === PREVIEW_STATUS.succeeded
                ? null
                : outcome.safeErrorCode,
            completedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(previewRuns.workspaceId, scope.workspaceId),
              eq(previewRuns.id, scope.previewRunId),
              inArray(previewRuns.status, ['queued', 'running']),
            ),
          )
          .returning({ id: previewRuns.id })
          .catch(rethrowQueryFailure);
        if (syncedRuns.length !== 1)
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
      optionsFor(input.signal),
    );
  } catch (error: unknown) {
    if (
      error instanceof PreviewDeliveryMismatchError &&
      !input.signal?.aborted
    ) {
      await auditPreviewDeliveryMismatch(pool, previewConsumerName, {
        workspaceId: scope.workspaceId,
        delivery: input.delivery,
        signal: input.signal ?? new AbortController().signal,
      });
    }
    throw error;
  }
}

function canonicalPreviewOutcome(
  outcome: PreviewTerminalOutcome,
): CanonicalCompletionOutcome {
  return outcome.status === PREVIEW_STATUS.succeeded
    ? ({
        status: PREVIEW_STATUS.succeeded,
        outputRef: serializeStoredExecutionValue(outcome.output),
      } as const)
    : ({
        safeErrorCode: outcome.safeErrorCode,
        errorSummary: outcome.errorSummary ?? null,
        status: outcome.status,
      } as const);
}

async function writePreviewTerminalAttempt(
  client: PoolClient,
  scope: PreviewCompletionScope,
  {
    outcome,
    diagnostics,
  }: Readonly<{
    outcome: CanonicalCompletionOutcome;
    diagnostics: CodeDiagnostics | undefined;
  }>,
) {
  const terminal = await drizzle(client)
    .update(previewAttempts)
    .set({
      status: outcome.status,
      outputRef: sql`${outcome.status === PREVIEW_STATUS.succeeded ? outcome.outputRef : null}::json`,
      safeErrorCode:
        outcome.status === PREVIEW_STATUS.succeeded
          ? null
          : outcome.safeErrorCode,
      codeDiagnostics:
        diagnostics === undefined
          ? null
          : sql`${canonicalJson(diagnostics)}::jsonb`,
      errorSummary:
        outcome.status === PREVIEW_STATUS.succeeded
          ? null
          : outcome.errorSummary,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewAttempts.workspaceId, scope.workspaceId),
        eq(previewAttempts.id, scope.previewAttemptId),
        eq(previewAttempts.previewRunId, scope.previewRunId),
        eq(previewAttempts.status, 'running'),
        eq(previewAttempts.leaseOwner, scope.workerId),
        eq(previewAttempts.fenceToken, scope.attemptFenceToken),
      ),
    )
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);

  return terminal;
}
