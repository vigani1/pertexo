import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import type { DatabaseConfig } from '../config.js';
import {
  lockExpectedCompatibilityReleaseSet,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from '../compatibility/compatibility-release.js';
import {
  acceptWorkflowRun,
  WorkspaceRunQuotaExceededError,
} from '../execution/execution-acceptance.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from '../execution/published-workflow-reader.js';
import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
} from './schedule-recurrence.js';
import { withWorkspaceTransaction } from '../tenant-access/workspace.js';

const claimSchema = z.object({
  trigger_id: z.uuid(),
  workspace_id: z.uuid(),
  workflow_id: z.uuid(),
  workflow_version_id: z.uuid(),
  node_id: z.string(),
  recurrence_kind: z.enum(['cron', 'interval']),
  cron_expression: z.string().nullable(),
  timezone: z.string().nullable(),
  interval_minutes: z.number().int().nullable(),
  misfire_policy: z.enum(['catch_up_once', 'skip']),
  config_fingerprint: z.string(),
  anchor_at: z.date(),
  next_fire_at: z.date(),
  lease_token: z.uuid(),
  observed_at: z.date(),
});

export type ScheduleCheckpointFactory = (
  projection: PublishedWorkflowV2Projection,
  currentCompatibilityRelease: CompatibilityReleaseExpectation,
) => Readonly<{ engineVersion: string; checkpoint: unknown }>;

export type ScanDueSchedulesResult = Readonly<{
  claimed: number;
  accepted: number;
  skipped: number;
  deferred: number;
  maxLagSeconds: number;
}>;

export interface ScheduleTriggerScanner {
  scanDue(
    input: Readonly<{
      leaseOwner: string;
      limit: number;
      leaseSeconds: number;
      checkpointFactory: ScheduleCheckpointFactory;
      signal?: AbortSignal;
    }>,
  ): Promise<ScanDueSchedulesResult>;
  close(): Promise<void>;
}

export class ScheduleClaimLostError extends Error {
  public override readonly name = 'ScheduleClaimLostError';
}

export function createScheduleTriggerScanner(
  claimConfig: DatabaseConfig,
  compatibilityReleaseInput:
    CompatibilityReleaseExpectation | CompatibilityReleaseExpectationSet,
  acceptanceConfig: DatabaseConfig,
  runtimes: Readonly<{
    acceptance?: DatabaseRuntime;
    claim?: DatabaseRuntime;
  }> = {},
): ScheduleTriggerScanner {
  const claimLease = acquireDatabasePool(claimConfig, runtimes.claim);
  const acceptanceLease = acquireDatabasePool(
    acceptanceConfig,
    runtimes.acceptance,
  );
  const claimPool = claimLease.pool;
  const acceptancePool = acceptanceLease.pool;
  const compatibilityReleases = Array.isArray(compatibilityReleaseInput)
    ? parseCompatibilityReleaseExpectationSet(compatibilityReleaseInput)
    : Object.freeze([
        parseCompatibilityReleaseExpectation(compatibilityReleaseInput),
      ]);
  return Object.freeze({
    scanDue: async (
      input: Parameters<ScheduleTriggerScanner['scanDue']>[0],
    ) => {
      const leaseOwner = z.string().min(1).max(128).parse(input.leaseOwner);
      const limit = z.number().int().min(1).max(100).parse(input.limit);
      const leaseSeconds = z
        .number()
        .int()
        .min(1)
        .max(300)
        .parse(input.leaseSeconds);
      const claimed = await claimPool.query<Record<string, unknown>>({
        text: 'select * from app.claim_due_trigger_schedules($1,$2,$3)',
        values: [leaseOwner, limit, leaseSeconds],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      let accepted = 0;
      let skipped = 0;
      let deferred = 0;
      let maxLagSeconds = 0;
      for (const raw of claimed.rows) {
        const claim = claimSchema.parse(raw);
        maxLagSeconds = Math.max(
          maxLagSeconds,
          (claim.observed_at.getTime() - claim.next_fire_at.getTime()) / 1_000,
        );
        const recurrence = parseScheduleRecurrence(
          claim.recurrence_kind === 'cron'
            ? {
                kind: 'cron',
                expression: claim.cron_expression,
                timezone: claim.timezone,
              }
            : {
                kind: 'interval',
                intervalMinutes: claim.interval_minutes,
              },
        );
        const observation = resolveScheduleObservation(
          recurrence,
          claim.anchor_at,
          claim.observed_at,
        );
        const scheduledAt = observation.greatestDueAt;
        if (scheduledAt === null) {
          await claimPool.query(
            'select app.release_trigger_schedule_claim($1,$2)',
            [claim.trigger_id, claim.lease_token],
          );
          deferred += 1;
          continue;
        }
        try {
          await withWorkspaceTransaction(
            acceptancePool,
            claim.workspace_id,
            async (transaction) => {
              let runId: string | null = null;
              if (claim.misfire_policy === 'catch_up_once') {
                const eligible = await transaction.db.execute<{
                  eligible: boolean;
                }>(sql`
                  select app.schedule_claim_is_eligible(
                    ${claim.trigger_id},${claim.lease_token}) eligible
                `);
                if (eligible.rows[0]?.eligible !== true)
                  throw new ScheduleClaimLostError(
                    'Schedule is no longer eligible',
                  );
                const version = await transaction.db.execute(sql<
                  Record<string, unknown>
                >`
                  select id,workspace_id,workflow_id,version_number,schema_version,checksum,
                         executable_schema_version,executable_json,compatibility_release_epoch
                   from app.workflow_versions
                   where workspace_id=${claim.workspace_id}
                     and id=${claim.workflow_version_id}
                `);
                const classified = classifyPublishedWorkflowVersionRow(
                  version.rows[0],
                );
                if (classified.kind !== 'v2_projection')
                  throw new ScheduleClaimLostError(
                    'Schedule is no longer eligible',
                  );
                const currentCompatibilityRelease =
                  await lockExpectedCompatibilityReleaseSet(
                    transaction.db,
                    compatibilityReleases,
                  );
                const initial = input.checkpointFactory(
                  classified.workflowVersion,
                  currentCompatibilityRelease,
                );
                const identity = `${claim.trigger_id}:${scheduledAt.toISOString()}`;
                const result = await acceptWorkflowRun(transaction, {
                  engineVersion: initial.engineVersion,
                  initialCheckpoint: initial.checkpoint,
                  keyHash: createHash('sha256').update(identity).digest('hex'),
                  operation: 'workflow.run.accept',
                  requestHash: createHash('sha256')
                    .update(`${identity}:${claim.config_fingerprint}`)
                    .digest('hex'),
                  scope: `schedule:${claim.trigger_id}`,
                  triggerType: 'schedule',
                  workflowId: claim.workflow_id,
                  workflowVersionId: claim.workflow_version_id,
                  runInput: {
                    schemaVersion: 1,
                    triggerId: claim.trigger_id,
                    nodeId: claim.node_id,
                    scheduledAt: scheduledAt.toISOString(),
                  },
                });
                runId = result.runId;
              }
              const completed = await transaction.db.execute<{
                completed: boolean;
              }>(sql`
                select app.complete_trigger_schedule_claim(
                  ${claim.trigger_id},${claim.lease_token},${generatePersistedId()},${scheduledAt},
                  ${claim.misfire_policy === 'skip' ? 'skipped' : 'accepted'},
                  ${runId},${observation.nextAt}) completed
              `);
              if (completed.rows[0]?.completed !== true)
                throw new ScheduleClaimLostError('Schedule claim expired');
            },
          );
          if (claim.misfire_policy === 'skip') skipped += 1;
          else accepted += 1;
        } catch (error: unknown) {
          if (error instanceof WorkspaceRunQuotaExceededError) {
            await claimPool.query(
              'select app.defer_trigger_schedule_claim($1,$2,$3)',
              [claim.trigger_id, claim.lease_token, error.retryAfterSeconds],
            );
            deferred += 1;
            continue;
          }
          await claimPool.query(
            'select app.fail_trigger_schedule_claim($1,$2)',
            [claim.trigger_id, claim.lease_token],
          );
          throw error;
        }
      }
      return Object.freeze({
        claimed: claimed.rowCount ?? claimed.rows.length,
        accepted,
        skipped,
        deferred,
        maxLagSeconds,
      });
    },
    close: async () => {
      await Promise.all([claimLease.close(), acceptanceLease.close()]);
    },
  });
}
