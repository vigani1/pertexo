import { credentialCommandScope } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { workflowTriggers, triggerSchedules } from '@pertexo/database/schema';

import { ScheduleTriggerError } from '../schedule-trigger.errors.js';

import type {
  ScheduleCommandIdentity,
  ScheduleHealthTransition,
  SetEnabledInput,
} from './schedule-management.types.js';

export function scheduleCommandIdentity(
  input: SetEnabledInput,
): ScheduleCommandIdentity {
  const triggerId = input.triggerId;
  return Object.freeze({
    idempotencyKey: input.idempotencyKey,
    operation: 'schedule.trigger.setenabled',
    requestHash: input.requestHash,
    scope: credentialCommandScope(
      `${input.actorId}:${triggerId}`,
      input.commandCredentialId,
    ),
    triggerId,
    workflowId: input.workflowId,
  });
}

export function scheduleCommand(
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
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: input.enabled
      ? 'schedule_trigger.enabled'
      : 'schedule_trigger.disabled',
    targetType: 'schedule_trigger',
    targetId: identity.triggerId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: { workflowId: identity.workflowId },
  });
}
