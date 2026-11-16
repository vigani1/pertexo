import { decodeStoredValue } from '../../../shared/stored-values.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  ScheduleTriggerError,
  requireSchedule,
} from '../schedule-trigger.errors.js';
import type {
  ScheduleCommandIdentity,
  ScheduleTriggerCommandResult,
  SetEnabledInput,
} from './schedule-management.types.js';
import {
  parseStoredScheduleTrigger,
  readSchedule,
} from './schedule-state.repository.js';
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
  try {
    const stored = decodeStoredValue(() =>
      z.looseObject({ trigger: z.unknown() }).parse(claimed),
    );
    return Object.freeze({
      trigger: parseStoredScheduleTrigger(stored.trigger),
      replayed: true,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError)
      throw new ScheduleTriggerError('idempotency_conflict');
    throw error;
  }
}

export async function completeScheduleCommand(
  client: PoolClient,
  input: SetEnabledInput,
  identity: ScheduleCommandIdentity,
): Promise<ScheduleTriggerCommandResult> {
  const trigger = requireSchedule(
    await readSchedule(
      client,
      input.workspaceId,
      identity.workflowId,
      identity.triggerId,
    ),
  );
  await completeCommand(client, scheduleCommand(input, identity), {
    trigger,
  });
  return Object.freeze({ trigger, replayed: false });
}
