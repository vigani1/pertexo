import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import {
  lockExpectedCompatibilityReleaseSet,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';
import {
  acceptWorkflowRun,
  WorkspaceRunQuotaExceededError,
} from './execution-acceptance.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from './published-workflow-reader.js';
import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
} from './schedule-recurrence.js';
import {
  readHealth,
  refreshWorkflowActivation,
  type WorkflowTriggerHealth,
} from './workflow-triggers.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from './workspace.js';

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
}>;

export interface ScheduleTriggerScanner {
  scanDue(
    input: Readonly<{
      leaseOwner: string;
      limit: number;
      leaseSeconds: number;
      checkpointFactory: ScheduleCheckpointFactory;
    }>,
  ): Promise<ScanDueSchedulesResult>;
  close(): Promise<void>;
}

export class ScheduleClaimLostError extends Error {
  public override readonly name = 'ScheduleClaimLostError';
}

export interface ScheduleTriggerDatabase {
  setEnabled(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      triggerId: string;
      enabled: boolean;
    }>,
  ): Promise<WorkflowTriggerHealth>;
  close(): Promise<void>;
}

export class ScheduleTriggerNotFoundError extends Error {
  public override readonly name = 'ScheduleTriggerNotFoundError';
}

async function authorizeScheduleManager(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
      join app.workspaces workspace on workspace.id=membership.workspace_id
      join app.users actor on actor.id=membership.user_id
     where membership.workspace_id=$1 and membership.user_id=$2
       and membership.status='active' and membership.role in ('owner','admin')
       and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1) throw new ScheduleTriggerNotFoundError();
}

export function createScheduleTriggerDatabase(
  config: DatabaseConfig,
): ScheduleTriggerDatabase {
  const pool = new Pool(config);
  return Object.freeze({
    setEnabled: async (
      input: Parameters<ScheduleTriggerDatabase['setEnabled']>[0],
    ) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: z.uuid().parse(input.workspaceId),
          actorId: z.uuid().parse(input.actorId),
        },
        async (client) => {
          await authorizeScheduleManager(
            client,
            input.workspaceId,
            input.actorId,
          );
          const triggerId = z.uuid().parse(input.triggerId);
          const result = await client.query<{
            workflow_id: string;
            recurrence_kind: 'cron' | 'interval';
            cron_expression: string | null;
            timezone: string | null;
            interval_minutes: number | null;
            misfire_policy: 'catch_up_once' | 'skip';
            anchor_at: Date;
            next_fire_at: Date;
          }>(
            `select trigger.workflow_id,schedule.recurrence_kind,schedule.cron_expression,
                    schedule.timezone,schedule.interval_minutes,schedule.misfire_policy,
                    schedule.anchor_at,schedule.next_fire_at
               from app.trigger_schedules schedule
               join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
              where schedule.workspace_id=$1 and schedule.trigger_id=$2
                and trigger.kind='schedule' for update of schedule,trigger`,
            [input.workspaceId, triggerId],
          );
          const row = result.rows[0];
          if (row === undefined) throw new ScheduleTriggerNotFoundError();
          let nextFireAt = row.next_fire_at;
          if (input.enabled && row.misfire_policy === 'skip') {
            const observed = await client.query<{ observed_at: Date }>(
              'select clock_timestamp() observed_at',
            );
            const observedAt = observed.rows[0]?.observed_at;
            if (observedAt === undefined)
              throw new Error('Schedule database observation is unavailable');
            const recurrence = parseScheduleRecurrence(
              row.recurrence_kind === 'cron'
                ? {
                    kind: 'cron',
                    expression: row.cron_expression,
                    timezone: row.timezone,
                  }
                : {
                    kind: 'interval',
                    intervalMinutes: row.interval_minutes,
                  },
            );
            nextFireAt = resolveScheduleObservation(
              recurrence,
              row.anchor_at,
              observedAt,
            ).nextAt;
          }
          await client.query(
            `update app.trigger_schedules set status=$3,health_status=$4,
               next_fire_at=$5,lease_owner=null,lease_token=null,lease_acquired_at=null,
               lease_expires_at=null,updated_at=clock_timestamp()
              where workspace_id=$1 and trigger_id=$2`,
            [
              input.workspaceId,
              triggerId,
              input.enabled ? 'enabled' : 'disabled',
              input.enabled ? 'healthy' : 'disabled',
              nextFireAt,
            ],
          );
          await client.query(
            `update app.workflow_triggers set status=$3,health_status=$4,
               updated_at=clock_timestamp() where workspace_id=$1 and id=$2`,
            [
              input.workspaceId,
              triggerId,
              input.enabled ? 'active' : 'disabled',
              input.enabled ? 'healthy' : 'disabled',
            ],
          );
          await refreshWorkflowActivation(
            client,
            input.workspaceId,
            row.workflow_id,
          );
          const health = await readHealth(
            client,
            input.workspaceId,
            row.workflow_id,
          );
          const trigger = health.find(({ id }) => id === triggerId);
          if (trigger === undefined) throw new ScheduleTriggerNotFoundError();
          return trigger;
        },
      ),
    close: () => pool.end(),
  });
}

export function createScheduleTriggerScanner(
  claimConfig: DatabaseConfig,
  compatibilityReleaseInput:
    CompatibilityReleaseExpectation | CompatibilityReleaseExpectationSet,
  acceptanceConfig: DatabaseConfig,
): ScheduleTriggerScanner {
  const claimPool = new Pool(claimConfig);
  const acceptancePool = new Pool(acceptanceConfig);
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
      const claimed = await claimPool.query<Record<string, unknown>>(
        'select * from app.claim_due_trigger_schedules($1,$2,$3)',
        [leaseOwner, limit, leaseSeconds],
      );
      let accepted = 0;
      let skipped = 0;
      let deferred = 0;
      for (const raw of claimed.rows) {
        const claim = claimSchema.parse(raw);
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
                const version = await transaction.db.execute<
                  Record<string, unknown>
                >(sql`
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
                  ${claim.trigger_id},${claim.lease_token},${randomUUID()},${scheduledAt},
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
          await claimPool.query(
            'select app.release_trigger_schedule_claim($1,$2)',
            [claim.trigger_id, claim.lease_token],
          );
          if (error instanceof WorkspaceRunQuotaExceededError) {
            deferred += 1;
            continue;
          }
          throw error;
        }
      }
      return Object.freeze({
        claimed: claimed.rowCount ?? claimed.rows.length,
        accepted,
        skipped,
        deferred,
      });
    },
    close: async () => {
      await Promise.all([claimPool.end(), acceptancePool.end()]);
    },
  });
}
