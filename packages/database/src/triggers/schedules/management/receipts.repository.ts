import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { triggerSchedules } from '../../../schema/triggers/schedules.js';
import { workflowTriggers } from '../../../schema/authoring/workflows.js';
import { auditEvents } from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
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
  const db = drizzle(client);
  await db
    .update(triggerSchedules)
    .set({
      status: transition.scheduleStatus,
      healthStatus: transition.healthStatus,
      lastErrorCode: transition.lastErrorCode,
      nextFireAt: transition.nextFireAt,
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(triggerSchedules.workspaceId, workspaceId),
        eq(triggerSchedules.triggerId, triggerId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(workflowTriggers)
    .set({
      status: transition.triggerStatus,
      healthStatus: transition.healthStatus,
      lastErrorCode: transition.lastErrorCode,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowTriggers.workspaceId, workspaceId),
        eq(workflowTriggers.id, triggerId),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function recordScheduleCommandAudit(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<void> {
  await drizzle(client)
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: input.enabled
        ? 'schedule_trigger.enabled'
        : 'schedule_trigger.disabled',
      targetType: 'schedule_trigger',
      targetId: identity.triggerId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: { workflowId: identity.workflowId },
    })
    .catch(rethrowQueryFailure);
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
