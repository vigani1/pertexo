import { z } from 'zod';

export const FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES = 4_096;
export const FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT = 100;

const safeCodeSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);

export const FailureNotificationDestinationConfigSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('slack'),
        connectionId: z.uuid(),
        channelId: z.string().regex(/^[CDGU][A-Z0-9]{1,79}$/u),
      })
      .strict(),
    z
      .object({
        kind: z.literal('email'),
        connectionId: z.uuid(),
        toEmail: z
          .email()
          .max(254)
          .overwrite((value) => {
            const at = value.lastIndexOf('@');
            return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
          }),
      })
      .strict(),
  ],
);

export type FailureNotificationDestinationConfig = z.output<
  typeof FailureNotificationDestinationConfigSchema
>;

export const FailureNotificationContextSchema = z
  .object({
    runId: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    terminalEventSequence: z.number().int().positive(),
    terminalStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
    triggerType: z.enum(['api', 'manual', 'replay', 'schedule', 'webhook']),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    primaryFailure: z.union([
      z
        .object({
          nodeId: z.string().min(1).max(128),
          invocationKey: z.string().min(1).max(256),
          nodeStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
          attemptNumber: z.number().int().nonnegative(),
          safeErrorCode: safeCodeSchema,
        })
        .strict(),
      z
        .object({
          source: z.literal('run'),
          runStatus: z.enum(['failed', 'timed_out']),
          safeErrorCode: safeCodeSchema,
        })
        .strict(),
    ]),
    totalFailureCount: z.number().int().positive().max(10_000),
  })
  .strict();

export const FailureNotificationDeliveryResultSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('delivered'),
        possiblyDispatched: z.literal(true),
        providerReference: z.string().min(1).max(256).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('definite_failure'),
        safeErrorCode: safeCodeSchema,
        possiblyDispatched: z.literal(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('retry'),
        safeErrorCode: safeCodeSchema,
        possiblyDispatched: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('outcome_unknown'),
        safeErrorCode: safeCodeSchema,
        possiblyDispatched: z.literal(true),
      })
      .strict(),
  ],
);

export type FailureNotificationContext = Readonly<
  z.output<typeof FailureNotificationContextSchema>
>;
export type FailureNotificationDeliveryResult = Readonly<
  z.output<typeof FailureNotificationDeliveryResultSchema>
>;
