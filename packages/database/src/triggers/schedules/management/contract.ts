import { z } from 'zod';

import type { ScheduleTriggerReads } from '../reads.queries.js';

export const uuidSchema = z.uuid();

export const scheduleTriggerSchema = z
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

export type SetEnabledInput = Parameters<
  ScheduleTriggerDatabase['setEnabled']
>[0];

export type ScheduleCommandIdentity = Readonly<{
  idempotencyKey: string;
  operation: 'schedule.trigger.setenabled';
  requestHash: string;
  scope: string;
  triggerId: string;
  workflowId: string;
}>;

export type ScheduleCommandTarget = Readonly<{
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

export type ScheduleHealthTransition = Readonly<{
  healthStatus: 'degraded' | 'disabled' | 'healthy';
  lastErrorCode: 'schedule.admission_throttled' | null;
  nextFireAt: Date;
  scheduleStatus: 'disabled' | 'enabled';
  triggerStatus: 'active' | 'disabled';
}>;
