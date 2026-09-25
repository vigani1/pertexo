import { createHash } from 'node:crypto';

import type {
  ScheduleFireTimesResponse,
  ScheduleManagementCommandResponse,
  ScheduleOccurrenceListResponse,
  ScheduleStepConfig,
  ScheduleTriggerHealthResponse,
} from '@pertexo/contracts/schedules';

import {
  ScheduleTriggerError,
  type ScheduleFireTimes,
  type ScheduleOccurrenceRecord,
  type ScheduleTriggerDatabase,
  type ScheduleTriggerRecord,
} from '@pertexo/database/api';

import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import {
  decodeScheduleOccurrenceCursor,
  encodeScheduleOccurrenceCursor,
  InvalidScheduleOccurrenceCursorError,
} from './cursor.js';
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

  /** ADR 048: one schedule's retained occurrence metadata, newest first. */
  public listOccurrences(
    input: TriggerReadInput & Readonly<{ limit?: number; after?: string }>,
  ): Promise<ScheduleOccurrenceListResponse> {
    return this.telemetry.measure('schedule.occurrences', async () => {
      try {
        const page = await this.database.listOccurrences({
          ...triggerRead(input),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.after === undefined
            ? {}
            : {
                after: decodeScheduleOccurrenceCursor(
                  input.after,
                  input.triggerId,
                ),
              }),
        });
        return {
          items: page.items.map(publicOccurrence),
          nextCursor:
            page.nextCursor === undefined
              ? null
              : encodeScheduleOccurrenceCursor(
                  input.triggerId,
                  page.nextCursor,
                ),
        };
      } catch (error: unknown) {
        return this.mapError(error);
      }
    });
  }

  /** ADR 048: when a published schedule fires next, by the scheduler's rules. */
  public nextRuns(
    input: TriggerReadInput & Readonly<{ count: number }>,
  ): Promise<ScheduleFireTimesResponse> {
    return this.telemetry.measure('schedule.next_runs', async () => {
      try {
        return publicFireTimes(
          await this.database.nextFireTimes({
            ...triggerRead(input),
            count: input.count,
          }),
        );
      } catch (error: unknown) {
        return this.mapError(error);
      }
    });
  }

  /** ADR 048: when an unsaved Schedule step would fire if published now. */
  public previewRuns(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
      config: ScheduleStepConfig;
      count: number;
    }>,
  ): Promise<ScheduleFireTimesResponse> {
    return this.telemetry.measure('schedule.preview', async () => {
      try {
        return publicFireTimes(
          await this.database.previewFireTimes({
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            workflowId: input.workflowId,
            recurrence: recurrenceOf(input.config),
            count: input.count,
          }),
        );
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
    if (error instanceof InvalidScheduleOccurrenceCursorError)
      return throwApplicationError(
        applicationError('request.invalid', {
          safeDetail: 'The occurrence cursor is invalid.',
        }),
      );
    if (error instanceof ScheduleTriggerError) {
      switch (error.code) {
        case 'not_found':
          return throwApplicationError(applicationError('resource.not_found'));
        case 'invalid_recurrence':
          return throwApplicationError(
            applicationError('request.invalid', {
              safeDetail:
                'The schedule rule cannot be scheduled. Check the cron fields and the timezone.',
            }),
          );
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

type TriggerReadInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  triggerId: string;
}>;

function triggerRead(input: TriggerReadInput): TriggerReadInput {
  return {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    workflowId: input.workflowId,
    triggerId: input.triggerId,
  };
}

/** The rule alone: the misfire policy never changes when a schedule fires. */
function recurrenceOf(config: ScheduleStepConfig) {
  return config.kind === 'cron'
    ? {
        kind: config.kind,
        expression: config.expression,
        timezone: config.timezone,
      }
    : { kind: config.kind, intervalMinutes: config.intervalMinutes };
}

function publicOccurrence(
  occurrence: ScheduleOccurrenceRecord,
): ScheduleOccurrenceListResponse['items'][number] {
  return {
    id: occurrence.id,
    scheduledAt: occurrence.scheduledAt,
    recordedAt: occurrence.recordedAt,
    outcome: occurrence.outcome,
    runId: occurrence.runId,
  };
}

function publicFireTimes(times: ScheduleFireTimes): ScheduleFireTimesResponse {
  return {
    observedAt: times.observedAt.toISOString(),
    items: times.items.map((instant) => ({
      scheduledAt: instant.toISOString(),
    })),
  };
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
