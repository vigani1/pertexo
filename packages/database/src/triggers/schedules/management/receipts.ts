import { generatePersistedId } from '../../../platform/persisted-id.js';
import {claimCommand, completeCommand} from '../../../platform/idempotency/repository.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256HexSchema as digestSchema } from '../../../platform/persisted-primitives.js';

import { ScheduleTriggerError } from '../errors.js';

import {
  uuidSchema,
  type ScheduleTriggerCommandResult,
  type SetEnabledInput,
  type ScheduleCommandIdentity,
  type ScheduleHealthTransition,
} from './contract.js';
import { parseStoredScheduleTrigger, readSchedule } from './state.queries.js';

export function scheduleCommandIdentity(
  input: SetEnabledInput,
): ScheduleCommandIdentity {
  const triggerId = uuidSchema.parse(input.triggerId);
  return Object.freeze({
    idempotencyKey: z.string().min(1).max(128).parse(input.idempotencyKey),
    operation: 'schedule.trigger.setenabled',
    requestHash: digestSchema.parse(input.requestHash),
    scope: `${input.actorId}:${triggerId}`,
    triggerId,
    workflowId: uuidSchema.parse(input.workflowId),
  });
}

function scheduleCommand(
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
) {
  return {
    workspaceId: input.workspaceId,
    operation: identity.operation,
    scope: identity.scope,
    idempotencyKey: identity.idempotencyKey,
    requestHash: identity.requestHash,
    conflict: () => new ScheduleTriggerError('idempotency_conflict'),
  };
}

export async function claimScheduleCommand(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<ScheduleTriggerCommandResult | null> {
  const claimed = await claimCommand(client, {
    ...scheduleCommand(input, identity),
    resourceId: identity.triggerId,
  });
  if (claimed === null) return null;
  const stored = z.looseObject({ trigger: z.unknown() }).parse(claimed);
  return Object.freeze({
    trigger: parseStoredScheduleTrigger(stored.trigger),
    replayed: true,
  });
}

export async function applyScheduleHealthTransition(
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

export async function recordScheduleCommandAudit(
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

export async function completeScheduleCommand(
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
  await completeCommand(client, scheduleCommand(input, identity), {
    trigger,
  });
  return Object.freeze({ trigger, replayed: false });
}
