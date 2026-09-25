import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { createHash } from 'node:crypto';

import { generatePersistedId } from '../platform/persisted-id.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../validation/persisted-primitives.js';

import type { DatabaseConfig } from '../config.js';
import { ScheduleTriggerError } from './schedule-trigger-errors.js';
import {
  parsePersistedScheduleRecurrence,
  resolveScheduleObservation,
} from './schedule-recurrence.js';
import {
  authorizeScheduleReader,
  createScheduleTriggerReads,
  type ScheduleTriggerReads,
} from './schedule-trigger-reads.js';
import { refreshWorkflowActivation } from './workflow-triggers.js';
import { canManageWorkflowTrigger } from './trigger-management-access.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

const uuidSchema = z.uuid();
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

export interface ScheduleTriggerDatabase extends ScheduleTriggerReads {
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
    recurrence: parsePersistedScheduleRecurrence({
      recurrence_kind: kind,
      cron_expression: z.string().nullable().parse(row.cron_expression),
      timezone: z.string().nullable().parse(row.timezone),
      interval_minutes: z.number().int().nullable().parse(row.interval_minutes),
    }),
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

type SetEnabledInput = Parameters<ScheduleTriggerDatabase['setEnabled']>[0];

type ScheduleCommandIdentity = Readonly<{
  keyHash: string;
  operation: 'schedule.trigger.setenabled';
  requestHash: string;
  scope: string;
  triggerId: string;
  workflowId: string;
}>;

type ScheduleCommandTarget = Readonly<{
  workflow_id: string;
  status: 'disabled' | 'enabled';
  recurrence_kind: 'cron' | 'interval';
  cron_expression: string | null;
  timezone: string | null;
  interval_minutes: number | null;
  misfire_policy: 'catch_up_once' | 'skip';
  anchor_at: Date;
  next_fire_at: Date;
  admission_deferred_until: Date | null;
  observed_at: Date;
}>;

type ScheduleHealthTransition = Readonly<{
  healthStatus: 'degraded' | 'disabled' | 'healthy';
  lastErrorCode: 'schedule.admission_throttled' | null;
  nextFireAt: Date;
  scheduleStatus: 'disabled' | 'enabled';
  triggerStatus: 'active' | 'disabled';
}>;

function scheduleCommandIdentity(
  input: SetEnabledInput,
): ScheduleCommandIdentity {
  const triggerId = uuidSchema.parse(input.triggerId);
  return Object.freeze({
    keyHash: idempotencyKeyHash(input.idempotencyKey),
    operation: 'schedule.trigger.setenabled',
    requestHash: digestSchema.parse(input.requestHash),
    scope: `${input.actorId}:${triggerId}`,
    triggerId,
    workflowId: uuidSchema.parse(input.workflowId),
  });
}

async function claimScheduleCommand(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<ScheduleTriggerCommandResult | null> {
  await client.query(
    `insert into app.idempotency_records
      (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref,expires_at)
     values($1,$2,$3,$4,$5,$6,'in_progress',$7,'{}'::jsonb,
       clock_timestamp()+interval '24 hours')
     on conflict(workspace_id,operation,scope,key_hash) do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      identity.operation,
      identity.scope,
      identity.keyHash,
      identity.requestHash,
      identity.triggerId,
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
    [input.workspaceId, identity.operation, identity.scope, identity.keyHash],
  );
  const claim = command.rows[0];
  if (claim === undefined)
    throw new Error('Schedule command claim is unavailable');
  if (claim.request_hash !== identity.requestHash)
    throw new ScheduleTriggerError('idempotency_conflict');
  if (claim.status !== 'completed') return null;
  const stored = z
    .looseObject({ trigger: z.unknown() })
    .parse(claim.result_ref);
  return Object.freeze({
    trigger: parseStoredScheduleTrigger(stored.trigger),
    replayed: true,
  });
}

async function readScheduleCommandTarget(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<ScheduleCommandTarget> {
  const result = await client.query<ScheduleCommandTarget>(
    `select trigger.workflow_id,schedule.status,schedule.recurrence_kind,
            schedule.cron_expression,schedule.timezone,schedule.interval_minutes,
            schedule.misfire_policy,schedule.anchor_at,schedule.next_fire_at,
            schedule.admission_deferred_until,clock_timestamp() observed_at
       from app.trigger_schedules schedule
       join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
       where schedule.workspace_id=$1 and schedule.trigger_id=$2
         and trigger.workflow_id=$3
         and trigger.workflow_version_id=(select published_version_id
           from app.workflows where workspace_id=$1 and id=$3)
         and trigger.kind='schedule' for update of schedule,trigger`,
    [input.workspaceId, identity.triggerId, identity.workflowId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ScheduleTriggerError('not_found');
  return row;
}

function scheduleHealthTransition(
  input: SetEnabledInput,
  target: ScheduleCommandTarget,
): ScheduleHealthTransition {
  let nextFireAt = target.next_fire_at;
  if (
    input.enabled &&
    target.status === 'disabled' &&
    target.misfire_policy === 'skip'
  ) {
    nextFireAt = resolveScheduleObservation(
      parsePersistedScheduleRecurrence(target),
      target.anchor_at,
      target.observed_at,
    ).nextAt;
  }
  const retainsAdmissionBackoff =
    input.enabled &&
    target.admission_deferred_until !== null &&
    target.admission_deferred_until.getTime() > target.observed_at.getTime();
  return Object.freeze({
    healthStatus: input.enabled
      ? retainsAdmissionBackoff
        ? 'degraded'
        : 'healthy'
      : 'disabled',
    lastErrorCode: retainsAdmissionBackoff
      ? 'schedule.admission_throttled'
      : null,
    nextFireAt,
    scheduleStatus: input.enabled ? 'enabled' : 'disabled',
    triggerStatus: input.enabled ? 'active' : 'disabled',
  });
}

async function applyScheduleHealthTransition(
  client: PoolClient,
  workspaceId: string,
  triggerId: string,
  transition: ScheduleHealthTransition,
): Promise<void> {
  await client.query(
    `update app.trigger_schedules set status=$3,health_status=$4,
       last_error_code=$5,next_fire_at=$6,
       lease_owner=null,lease_token=null,lease_acquired_at=null,
       lease_expires_at=null,updated_at=clock_timestamp()
      where workspace_id=$1 and trigger_id=$2`,
    [
      workspaceId,
      triggerId,
      transition.scheduleStatus,
      transition.healthStatus,
      transition.lastErrorCode,
      transition.nextFireAt,
    ],
  );
  await client.query(
    `update app.workflow_triggers set status=$3,health_status=$4,
       last_error_code=$5,updated_at=clock_timestamp()
      where workspace_id=$1 and id=$2`,
    [
      workspaceId,
      triggerId,
      transition.triggerStatus,
      transition.healthStatus,
      transition.lastErrorCode,
    ],
  );
}

async function recordScheduleCommandAudit(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<void> {
  await client.query(
    `insert into app.audit_events
      (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     values($1,$2,$3,$4,'schedule_trigger',$5,$6,$7,$8::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      input.enabled ? 'schedule_trigger.enabled' : 'schedule_trigger.disabled',
      identity.triggerId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify({ workflowId: identity.workflowId }),
    ],
  );
}

async function completeScheduleCommand(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<ScheduleTriggerCommandResult> {
  const trigger = await readSchedule(
    client,
    input.workspaceId,
    identity.workflowId,
    identity.triggerId,
  );
  await client.query(
    `update app.idempotency_records set status='completed',result_ref=$1::jsonb,
       updated_at=clock_timestamp() where workspace_id=$2 and operation=$3
       and scope=$4 and key_hash=$5`,
    [
      JSON.stringify({ schemaVersion: 1, trigger }),
      input.workspaceId,
      identity.operation,
      identity.scope,
      identity.keyHash,
    ],
  );
  return Object.freeze({ trigger, replayed: false });
}

export function createScheduleTriggerDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ScheduleTriggerDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    ...createScheduleTriggerReads(pool),
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
          if (!(await canManageWorkflowTrigger(client, input)))
            throw new ScheduleTriggerError('not_found');
          const identity = scheduleCommandIdentity(input);
          const replay = await claimScheduleCommand(client, input, identity);
          if (replay !== null) return replay;
          const target = await readScheduleCommandTarget(
            client,
            input,
            identity,
          );
          const transition = scheduleHealthTransition(input, target);
          await applyScheduleHealthTransition(
            client,
            input.workspaceId,
            identity.triggerId,
            transition,
          );
          await refreshWorkflowActivation(
            client,
            input.workspaceId,
            target.workflow_id,
          );
          await recordScheduleCommandAudit(client, input, identity);
          return completeScheduleCommand(client, input, identity);
        },
      ),
    checkReadiness: async () => {
      await pool.query('select 1 from app.trigger_schedules limit 0');
    },
    close: () => lease.close(),
  });
}
