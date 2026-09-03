import { createHash } from 'node:crypto';

import {
  ScheduleTriggerError,
  type ScheduleTriggerDatabase,
  type ScheduleTriggerRecord,
} from '@pertexo/database/api';

import { applicationError } from '../platform/http/index.js';
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
  ) {
    return this.telemetry.measure('schedule.list', async () => {
      try {
        const items = await this.database.list(input);
        return { items: items.map(publicSchedule) };
      } catch (error: unknown) {
        return this.mapError(error);
      }
    });
  }

  public setEnabled(input: CommandInput, enabled: boolean) {
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
    if (error instanceof ScheduleTriggerError && error.code === 'not_found')
      return throwApplicationError(applicationError('resource.not_found'));
    if (error instanceof ScheduleTriggerError)
      return throwApplicationError(
        applicationError('request.idempotency_conflict', {
          safeDetail:
            'The idempotency key was already used for another request.',
        }),
      );
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

function publicSchedule(trigger: ScheduleTriggerRecord) {
  return {
    ...trigger,
    reconciledAt: trigger.reconciledAt?.toISOString() ?? null,
    nextFireAt: trigger.nextFireAt.toISOString(),
    lastFireAt: trigger.lastFireAt?.toISOString() ?? null,
  };
}

function throwApplicationError(
  error: ReturnType<typeof applicationError>,
): never {
  // The global problem filter consumes the frozen application error value.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw error;
}
