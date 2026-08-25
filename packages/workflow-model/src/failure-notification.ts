import { z } from 'zod';

export const FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES = 4_096;
export const FAILURE_NOTIFICATION_POLICY_VERSION = 1 as const;

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

export const FailureNotificationPolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.literal(FAILURE_NOTIFICATION_POLICY_VERSION),
    destinationId: z.uuid(),
    destinationConfigVersion: z.number().int().positive(),
    sideEffectClass: z.enum(['safe', 'idempotent_with_key', 'unsafe']),
  })
  .strict();

export const FailureNotificationContextV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    terminalEventSequence: z.number().int().positive(),
    terminalStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
    triggerType: z.enum(['api', 'manual', 'replay', 'schedule', 'webhook']),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    primaryFailure: z
      .object({
        nodeId: z.string().min(1).max(128),
        invocationKey: z.string().min(1).max(256),
        nodeStatus: z.enum(['failed', 'timed_out', 'outcome_unknown']),
        attemptNumber: z.number().int().nonnegative(),
        safeErrorCode: safeCodeSchema,
      })
      .strict(),
    totalFailureCount: z.number().int().positive().max(10_000),
  })
  .strict();

export const FailureNotificationDeliveryResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(['delivered', 'definite_failure', 'retry', 'outcome_unknown']),
    safeErrorCode: safeCodeSchema.optional(),
    possiblyDispatched: z.boolean(),
    providerReference: z.string().min(1).max(256).optional(),
  })
  .strict();

export type FailureNotificationPolicyV1 = Readonly<
  z.output<typeof FailureNotificationPolicyV1Schema>
>;
export type FailureNotificationContextV1 = Readonly<
  z.output<typeof FailureNotificationContextV1Schema>
>;
export type FailureNotificationDeliveryResultV1 = Readonly<
  z.output<typeof FailureNotificationDeliveryResultV1Schema>
>;
