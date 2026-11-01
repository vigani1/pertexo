import type { z } from 'zod';
import type { scheduleTriggerSchema } from './receipt.js';
import type { readScheduleCommandTarget } from './state.queries.js';

// Projection joins workflow triggers with schedule state and decoded recurrence.
export type ScheduleTriggerRecord = Readonly<
  z.output<typeof scheduleTriggerSchema>
>;

export type ScheduleTriggerCommandResult = Readonly<{
  trigger: ScheduleTriggerRecord;
  replayed: boolean;
}>;

export type ListSchedulesInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
}>;

export type SetEnabledInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  triggerId: string;
  enabled: boolean;
  idempotencyKey: string;
  requestHash: string;
  requestId?: string;
  traceId?: string;
}>;

export type ScheduleCommandIdentity = Readonly<{
  idempotencyKey: string;
  operation: 'schedule.trigger.setenabled';
  requestHash: string;
  scope: string;
  triggerId: string;
  workflowId: string;
}>;

export type ScheduleCommandTarget = Awaited<
  ReturnType<typeof readScheduleCommandTarget>
>;

export type ScheduleHealthTransition = Readonly<{
  healthStatus: 'degraded' | 'disabled' | 'healthy';
  lastErrorCode: 'schedule.admission_throttled' | null;
  nextFireAt: Date;
  scheduleStatus: 'disabled' | 'enabled';
  triggerStatus: 'active' | 'disabled';
}>;
