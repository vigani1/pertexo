import type { CodeDiagnostics } from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';

import {
  PREVIEW_STATUS,
  UNFINISHED_PREVIEW_STATUSES,
} from '../preview-state.js';
import type { CanonicalCompletionOutcome } from './outcome.js';

type AttemptScope = Readonly<{
  previewAttemptId: string;
  previewRunId: string;
  workspaceId: string;
}>;

const DEADLINE_EXCEEDED = 'preview.deadline_exceeded';

/** Times out an unfinished attempt and fences its lease; false if it had finished. */
export async function timeOutPreviewAttempt(
  client: PoolClient,
  scope: AttemptScope,
): Promise<boolean> {
  const attempt = await drizzle(client)
    .update(previewAttempts)
    .set({
      status: 'timed_out',
      safeErrorCode: DEADLINE_EXCEEDED,
      startedAt: sql`coalesce(${previewAttempts.startedAt},clock_timestamp())`,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewAttempts.workspaceId, scope.workspaceId),
        eq(previewAttempts.id, scope.previewAttemptId),
        eq(previewAttempts.previewRunId, scope.previewRunId),
        inArray(previewAttempts.status, UNFINISHED_PREVIEW_STATUSES),
      ),
    )
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);
  return attempt.length === 1;
}

/** Times out an unfinished run; false if it had finished. */
export async function timeOutPreviewRun(
  client: PoolClient,
  scope: Omit<AttemptScope, 'previewAttemptId'>,
): Promise<boolean> {
  const run = await drizzle(client)
    .update(previewRuns)
    .set({
      status: 'timed_out',
      safeErrorCode: DEADLINE_EXCEEDED,
      startedAt: sql`coalesce(${previewRuns.startedAt},clock_timestamp())`,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewRuns.workspaceId, scope.workspaceId),
        eq(previewRuns.id, scope.previewRunId),
        inArray(previewRuns.status, UNFINISHED_PREVIEW_STATUSES),
      ),
    )
    .returning({ id: previewRuns.id })
    .catch(rethrowQueryFailure);
  return run.length === 1;
}

/** Locks the attempt and its run, and reads the completion they store. */
export async function lockStoredCompletion(
  client: PoolClient,
  scope: AttemptScope,
) {
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
  return current[0];
}

/**
 * Writes the outcome onto the attempt the worker still leases under its
 * fence; false when that lease is gone.
 */
export async function writePreviewTerminalAttempt(
  client: PoolClient,
  scope: AttemptScope &
    Readonly<{ attemptFenceToken: number; workerId: string }>,
  {
    outcome,
    diagnostics,
  }: Readonly<{
    outcome: CanonicalCompletionOutcome;
    diagnostics: CodeDiagnostics | undefined;
  }>,
): Promise<boolean> {
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
  return terminal.length === 1;
}

/** Copies the attempt's outcome onto its unfinished run; false if it had finished. */
export async function syncPreviewRunOutcome(
  client: PoolClient,
  scope: Omit<AttemptScope, 'previewAttemptId'>,
  outcome: CanonicalCompletionOutcome,
): Promise<boolean> {
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
        inArray(previewRuns.status, UNFINISHED_PREVIEW_STATUSES),
      ),
    )
    .returning({ id: previewRuns.id })
    .catch(rethrowQueryFailure);
  return syncedRuns.length === 1;
}
