import { createDatabasePool } from '../postgres-telemetry.js';
import { createHash } from 'node:crypto';

import { generatePersistedId } from '../persisted-id.js';

import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { ScheduleTriggerError } from './schedule-trigger-errors.js';
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
import { refreshWorkflowActivation } from './workflow-triggers.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../tenant-access/workspace.js';

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
const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const scheduleTriggerSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z.string().min(1).max(256),
    kind: z.literal('schedule'),
    status: z.enum([
      'desired',
      'configuration_required',
      'pending',
      'active',
      'degraded',
      'disabled',
      'error',
    ]),
    healthStatus: z.enum(['healthy', 'degraded', 'unhealthy', 'disabled']),
    lastErrorCode: z.string().max(128).nullable(),
    reconciledAt: z.date().nullable(),
    recurrence: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('cron'),
        expression: z.string().min(1).max(256),
        timezone: z.string().min(1).max(128),
      }),
      z.object({
        kind: z.literal('interval'),
        intervalMinutes: z.number().int().min(1).max(43_200),
      }),
    ]),
    misfirePolicy: z.enum(['catch_up_once', 'skip']),
    nextFireAt: z.date(),
    lastFireAt: z.date().nullable(),
  })
  .strict();

export type ScheduleTriggerRecord = Readonly<
  z.output<typeof scheduleTriggerSchema>
>;
export type ScheduleTriggerCommandResult = Readonly<{
  trigger: ScheduleTriggerRecord;
  replayed: boolean;
}>;

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

export interface ScheduleTriggerDatabase {
  list(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
    }>,
  ): Promise<readonly ScheduleTriggerRecord[]>;
  setEnabled(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
      triggerId: string;
      enabled: boolean;
      idempotencyKey: string;
      requestHash: string;
      requestId?: string;
      traceId?: string;
    }>,
  ): Promise<ScheduleTriggerCommandResult>;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export { ScheduleTriggerError } from './schedule-trigger-errors.js';

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
        and membership.status='active' and membership.role in ('owner','admin','builder')
       and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1) throw new ScheduleTriggerError('not_found');
}

async function authorizeScheduleReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  workflowId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
      join app.workspaces workspace on workspace.id=membership.workspace_id
      join app.users actor on actor.id=membership.user_id
      join app.workflows workflow on workflow.workspace_id=membership.workspace_id
     where membership.workspace_id=$1 and membership.user_id=$2 and workflow.id=$3
       and membership.status='active'
       and membership.role in ('owner','admin','builder','operator','viewer')
       and workspace.status='active' and actor.status='active'`,
    [workspaceId, actorId, workflowId],
  );
  if (result.rowCount !== 1) throw new ScheduleTriggerError('not_found');
}

function mapScheduleTrigger(
  row: Record<string, unknown>,
): ScheduleTriggerRecord {
  const kind = z.enum(['cron', 'interval']).parse(row.recurrence_kind);
  return scheduleTriggerSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    nodeId: row.node_id,
    kind: 'schedule',
    status: row.status,
    healthStatus: row.health_status,
    lastErrorCode: row.last_error_code,
    reconciledAt: row.reconciled_at,
    recurrence:
      kind === 'cron'
        ? {
            kind,
            expression: row.cron_expression,
            timezone: row.timezone,
          }
        : { kind, intervalMinutes: row.interval_minutes },
    misfirePolicy: row.misfire_policy,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
  });
}

function parseStoredScheduleTrigger(value: unknown): ScheduleTriggerRecord {
  const stored = z.record(z.string(), z.unknown()).parse(value);
  return scheduleTriggerSchema.parse({
    ...stored,
    reconciledAt:
      stored.reconciledAt === null
        ? null
        : new Date(z.string().parse(stored.reconciledAt)),
    nextFireAt: new Date(z.string().parse(stored.nextFireAt)),
    lastFireAt:
      stored.lastFireAt === null
        ? null
        : new Date(z.string().parse(stored.lastFireAt)),
  });
}

const scheduleProjection = `select trigger.id,trigger.workflow_id,trigger.workflow_version_id,
       trigger.node_id,trigger.status,schedule.health_status,schedule.last_error_code,
       trigger.reconciled_at,schedule.recurrence_kind,schedule.cron_expression,
       schedule.timezone,schedule.interval_minutes,schedule.misfire_policy,
       schedule.next_fire_at,schedule.last_fire_at
  from app.trigger_schedules schedule
  join app.workflow_triggers trigger on trigger.workspace_id=schedule.workspace_id
   and trigger.id=schedule.trigger_id`;

async function readSchedule(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  triggerId: string,
): Promise<ScheduleTriggerRecord> {
  const result = await client.query<Record<string, unknown>>(
    `${scheduleProjection}
      where schedule.workspace_id=$1 and trigger.workflow_id=$2 and trigger.id=$3
        and trigger.kind='schedule'`,
    [workspaceId, workflowId, triggerId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return mapScheduleTrigger(row);
}

function idempotencyKeyHash(value: string): string {
  return createHash('sha256')
    .update(z.string().min(1).max(128).parse(value))
    .digest('hex');
}

export function createScheduleTriggerDatabase(
  config: DatabaseConfig,
): ScheduleTriggerDatabase {
  const pool = createDatabasePool(config);
  return Object.freeze({
    list: (input: Parameters<ScheduleTriggerDatabase['list']>[0]) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: uuidSchema.parse(input.workspaceId),
          actorId: uuidSchema.parse(input.actorId),
        },
        async (client) => {
          const workflowId = uuidSchema.parse(input.workflowId);
          await authorizeScheduleReader(
            client,
            input.workspaceId,
            input.actorId,
            workflowId,
          );
          const result = await client.query<Record<string, unknown>>(
            `${scheduleProjection}
              where schedule.workspace_id=$1 and trigger.workflow_id=$2
                and trigger.kind='schedule'
                and trigger.workflow_version_id=(select published_version_id
                  from app.workflows where workspace_id=$1 and id=$2)
              order by trigger.node_id,trigger.id limit 1000`,
            [input.workspaceId, workflowId],
          );
          return Object.freeze(result.rows.map(mapScheduleTrigger));
        },
      ),
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
          const triggerId = uuidSchema.parse(input.triggerId);
          const workflowId = uuidSchema.parse(input.workflowId);
          const requestHash = digestSchema.parse(input.requestHash);
          const operation = 'schedule.trigger.setenabled';
          const keyHash = idempotencyKeyHash(input.idempotencyKey);
          const scope = `${input.actorId}:${triggerId}`;
          await client.query(
            `insert into app.idempotency_records
              (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref,expires_at)
             values($1,$2,$3,$4,$5,$6,'in_progress',$7,'{}'::jsonb,
               clock_timestamp()+interval '24 hours')
             on conflict(workspace_id,operation,scope,key_hash) do nothing`,
            [
              generatePersistedId(),
              input.workspaceId,
              operation,
              scope,
              keyHash,
              requestHash,
              triggerId,
            ],
          );
          const command = await client.query<{
            request_hash: string;
            status: string;
            result_ref: unknown;
          }>(
            `select request_hash,status,result_ref from app.idempotency_records
              where workspace_id=$1 and operation=$2 and scope=$3 and key_hash=$4
              for update`,
            [input.workspaceId, operation, scope, keyHash],
          );
          const claim = command.rows[0];
          if (claim === undefined)
            throw new Error('Schedule command claim is unavailable');
          if (claim.request_hash !== requestHash)
            throw new ScheduleTriggerError('idempotency_conflict');
          if (claim.status === 'completed') {
            const stored = z
              .looseObject({ trigger: z.unknown() })
              .parse(claim.result_ref);
            return Object.freeze({
              trigger: parseStoredScheduleTrigger(stored.trigger),
              replayed: true,
            });
          }
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
                 and trigger.workflow_id=$3
                 and trigger.workflow_version_id=(select published_version_id
                   from app.workflows where workspace_id=$1 and id=$3)
                 and trigger.kind='schedule' for update of schedule,trigger`,
            [input.workspaceId, triggerId, workflowId],
          );
          const row = result.rows[0];
          if (row === undefined) throw new ScheduleTriggerError('not_found');
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
          await client.query(
            `insert into app.audit_events
              (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
             values($1,$2,$3,$4,'schedule_trigger',$5,$6,$7,$8::jsonb)`,
            [
              generatePersistedId(),
              input.workspaceId,
              input.actorId,
              input.enabled
                ? 'schedule_trigger.enabled'
                : 'schedule_trigger.disabled',
              triggerId,
              input.requestId ?? null,
              input.traceId ?? null,
              JSON.stringify({ workflowId }),
            ],
          );
          const trigger = await readSchedule(
            client,
            input.workspaceId,
            workflowId,
            triggerId,
          );
          await client.query(
            `update app.idempotency_records set status='completed',result_ref=$1::jsonb,
               updated_at=clock_timestamp() where workspace_id=$2 and operation=$3
               and scope=$4 and key_hash=$5`,
            [
              JSON.stringify({ schemaVersion: 1, trigger }),
              input.workspaceId,
              operation,
              scope,
              keyHash,
            ],
          );
          return Object.freeze({
            trigger,
            replayed: false,
          });
        },
      ),
    checkReadiness: async () => {
      await pool.query('select 1 from app.trigger_schedules limit 0');
    },
    close: () => pool.end(),
  });
}

export function createScheduleTriggerScanner(
  claimConfig: DatabaseConfig,
  compatibilityReleaseInput:
    CompatibilityReleaseExpectation | CompatibilityReleaseExpectationSet,
  acceptanceConfig: DatabaseConfig,
): ScheduleTriggerScanner {
  const claimPool = createDatabasePool(claimConfig);
  const acceptancePool = createDatabasePool(acceptanceConfig);
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
      await Promise.all([claimPool.end(), acceptancePool.end()]);
    },
  });
}
