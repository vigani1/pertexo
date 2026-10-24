import {
  workflowRuns,
  nodeRuns,
  runEvents,
  runCheckpoints,
} from '../../../schema/runs/execution.js';
import { workflowRunValues } from '../../../schema/runs/values.js';
import { pendingRunTasks } from '../../../schema/runs/pending-task.js';
import { workflowCalls } from '../../../schema/runs/calls.js';
import {
  webhookTriggerDeliveries,
  webhookTriggerReplayRecords,
} from '../../../schema/triggers/deliveries.js';
import { triggerCoordinatedEvents } from '../../../schema/event-coordination/records.js';
import { triggerScheduleOccurrences } from '../../../schema/triggers/schedules.js';
import {
  and,
  asc,
  eq,
  exists,
  isNotNull,
  isNull,
  lte,
  not,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { expiredRunSql } from '../../../runs/data-policy.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { callHasNoPendingWork } from '../../calls/retention.repository.js';

// Live human interactions may outlast the normal input window.
export const runInputs = {
  name: 'run_inputs',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client);
    const page = db.$with('page').as(
      db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            isNotNull(workflowRuns.inputRef),
            lte(workflowRuns.inputRefExpiresAt, sql`clock_timestamp()`),
            notInArray(workflowRuns.status, ['queued', 'running', 'waiting']),
          ),
        )
        .orderBy(asc(workflowRuns.inputRefExpiresAt), asc(workflowRuns.id))
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .update(workflowRuns)
        .set({
          inputRef: null,
          inputRefExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(page)
        .where(eq(workflowRuns.id, page.id))
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
// The run summary stays; its output, error and cancel reason go with the
// details.
export const runDetails = {
  name: 'run_details',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client),
      run = alias(workflowRuns, 'run');
    const page = db.$with('page').as(
      db
        .select({ id: run.id })
        .from(run)
        .where(
          and(
            isNull(run.detailsPurgedAt),
            expiredRunSql('run'),
            notExists(
              db
                .select({ one: sql`1` })
                .from(workflowRunValues)
                .where(
                  and(
                    eq(workflowRunValues.workspaceId, run.workspaceId),
                    eq(workflowRunValues.workflowRunId, run.id),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(pendingRunTasks)
                .where(
                  and(
                    eq(pendingRunTasks.workspaceId, run.workspaceId),
                    eq(pendingRunTasks.runId, run.id),
                    eq(pendingRunTasks.kind, 'callback'),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(nodeRuns)
                .where(
                  and(
                    eq(nodeRuns.workspaceId, run.workspaceId),
                    eq(nodeRuns.workflowRunId, run.id),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(runEvents)
                .where(
                  and(
                    eq(runEvents.workspaceId, run.workspaceId),
                    eq(runEvents.workflowRunId, run.id),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(runCheckpoints)
                .where(
                  and(
                    eq(runCheckpoints.workspaceId, run.workspaceId),
                    eq(runCheckpoints.workflowRunId, run.id),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(run.completedAt), asc(run.id))
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .update(workflowRuns)
        .set({
          outputRef: null,
          errorSummary: null,
          cancelReason: null,
          variableSetRevision: null,
          detailsPurgedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(page)
        .where(eq(workflowRuns.id, page.id))
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
// A run summary goes 90 days after completion, once nothing refers to it.
export const runSummaries = {
  name: 'run_summaries',
  async run(client: PoolClient, pageSize: number): Promise<number> {
    const db = drizzle(client),
      run = alias(workflowRuns, 'run'),
      child = alias(workflowRuns, 'child');
    const blockingCall = db
      .select({ one: sql`1` })
      .from(workflowCalls)
      .where(
        and(
          eq(workflowCalls.workspaceId, run.workspaceId),
          or(
            eq(workflowCalls.liveChildRunId, run.id),
            and(
              eq(workflowCalls.parentRunId, run.id),
              not(callHasNoPendingWork(workflowCalls)),
            ),
          ),
        ),
      );
    const page = db.$with('page').as(
      db
        .select({ id: run.id })
        .from(run)
        .where(
          and(
            expiredRunSql('run', 'summary'),
            isNotNull(run.detailsPurgedAt),
            notExists(blockingCall),
            notExists(
              db
                .select({ one: sql`1` })
                .from(child)
                .where(
                  and(
                    eq(child.workspaceId, run.workspaceId),
                    eq(child.replaySourceRunId, run.id),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(webhookTriggerDeliveries)
                .where(
                  and(
                    eq(webhookTriggerDeliveries.workspaceId, run.workspaceId),
                    eq(webhookTriggerDeliveries.workflowRunId, run.id),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(webhookTriggerReplayRecords)
                .where(
                  and(
                    eq(
                      webhookTriggerReplayRecords.workspaceId,
                      run.workspaceId,
                    ),
                    eq(webhookTriggerReplayRecords.workflowRunId, run.id),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(triggerCoordinatedEvents)
                .where(
                  and(
                    eq(triggerCoordinatedEvents.workspaceId, run.workspaceId),
                    eq(triggerCoordinatedEvents.runId, run.id),
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(triggerScheduleOccurrences)
                .where(
                  and(
                    eq(triggerScheduleOccurrences.workspaceId, run.workspaceId),
                    eq(triggerScheduleOccurrences.workflowRunId, run.id),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(run.completedAt), asc(run.id))
        .limit(pageSize)
        .for('update', { skipLocked: true }),
    );
    return (
      await db
        .with(page)
        .delete(workflowRuns)
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(eq(page.id, workflowRuns.id)),
          ),
        )
        .returning({ one: sql`1` })
        .catch(rethrowQueryFailure)
    ).length;
  },
} as const;
