import { createHash } from 'node:crypto';

import type {
  ScheduleManagementCommandResponse,
  ScheduleTriggerHealthResponse,
} from '@pertexo/contracts/schedules';

import {
  ScheduleTriggerError,
  type ScheduleTriggerDatabase,
  type ScheduleTriggerRecord,
} from '@pertexo/database/api';

import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import {
  NOOP_SCHEDULE_TELEMETRY,
  type ScheduleTelemetry,
} from './telemetry.js';

export class ScheduleManagementService {
  public constructor(
    private readonly database: ScheduleTriggerDatabase,
    private readonly telemetry: ScheduleTelemetry = NOOP_SCHEDULE_TELEMETRY,
  ) {}

  public list(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
    }>,
  ): Promise<Readonly<{ items: readonly ScheduleTriggerHealthResponse[] }>> {
    return this.telemetry.measure('schedule.list', async () => {
      try {
        const items = await this.database.list(input);
        return { items: items.map(publicSchedule) };
      } catch (error: unknown) {
        return this.mapError(error);
      }
    });
  }

  public setEnabled(
    input: CommandInput,
    enabled: boolean,
  ): Promise<ScheduleManagementCommandResponse> {
    const operation = enabled ? 'schedule.enable' : 'schedule.disable';
    return this.telemetry.measure(operation, async () => {
      try {
        const result = await this.database.setEnabled({
          ...input,
          enabled,
          requestHash: createHash('sha256')
            .update(
              `${operation}\0${input.workspaceId}\0${input.actorId}\0${input.workflowId}\0${input.triggerId}`,
            )
            .digest('hex'),
        });
        return {
          trigger: publicSchedule(result.trigger),
          replayed: result.replayed,
        };
      } catch (error: unknown) {
        return this.mapError(error);
      }
    });
  }

  private mapError(error: unknown): never {
    if (error instanceof ScheduleTriggerError) {
      switch (error.code) {
        case 'not_found':
          return throwApplicationError(applicationError('resource.not_found'));
        case 'idempotency_conflict':
          return throwApplicationError(
            applicationError('request.idempotency_conflict', {
              safeDetail:
                'The idempotency key was already used for another request.',
            }),
          );
      }
    }
    throw error;
  }
}

type CommandInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  triggerId: string;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
}>;

function publicSchedule(
  trigger: ScheduleTriggerRecord,
): ScheduleTriggerHealthResponse {
  return {
    id: trigger.id,
    workflowId: trigger.workflowId,
    workflowVersionId: trigger.workflowVersionId,
    nodeId: trigger.nodeId,
    kind: trigger.kind,
    status: trigger.status,
    healthStatus: trigger.healthStatus,
    lastErrorCode: trigger.lastErrorCode,
    reconciledAt: trigger.reconciledAt?.toISOString() ?? null,
    recurrence: trigger.recurrence,
    misfirePolicy: trigger.misfirePolicy,
    nextFireAt: trigger.nextFireAt.toISOString(),
    lastFireAt: trigger.lastFireAt?.toISOString() ?? null,
  };
}
