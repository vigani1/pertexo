import './server-only.js';

import { z } from 'zod';

import { JOB_NAME, QUEUE_FOR_JOB, type JobName } from './names.js';

export const QUEUE_SCHEMA_VERSION = 1 as const;

const traceparentSchema = z
  .string()
  .regex(
    /^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/,
    'traceparent must use the bounded W3C version 00 format',
  )
  .refine(
    (value: string) => value.slice(3, 35) !== '0'.repeat(32),
    'traceparent trace-id must not be all zeroes',
  )
  .refine(
    (value: string) => value.slice(36, 52) !== '0'.repeat(16),
    'traceparent parent-id must not be all zeroes',
  );

const commonJobShape = {
  schemaVersion: z.literal(QUEUE_SCHEMA_VERSION),
  workspaceId: z.uuid(),
  outboxEventId: z.uuid(),
  traceparent: traceparentSchema.optional(),
} as const;

export const AdvanceWorkflowRunJobSchema = z
  .object({
    ...commonJobShape,
    runId: z.uuid(),
  })
  .strict();

export const ExecuteNodeAttemptJobSchema = z
  .object({
    ...commonJobShape,
    runId: z.uuid(),
    nodeRunId: z.uuid(),
    attemptId: z.uuid(),
  })
  .strict();

export const ExecutePreviewAttemptJobSchema = z
  .object({
    ...commonJobShape,
    previewRunId: z.uuid(),
    previewAttemptId: z.uuid(),
  })
  .strict();

export const ReconcilePreviewAttemptJobSchema = z
  .object({
    ...commonJobShape,
    previewRunId: z.uuid(),
    previewAttemptId: z.uuid(),
    attemptFenceToken: z.number().int().nonnegative(),
  })
  .strict();

export const ReconcileUnknownOutcomeJobSchema = z
  .object({
    ...commonJobShape,
    attemptId: z.uuid(),
    evidenceCommandId: z.uuid(),
  })
  .strict();

export const ReplayWorkflowRunJobSchema = z
  .object({
    ...commonJobShape,
    commandId: z.uuid(),
  })
  .strict();

export const SweepExpiredPreviewsJobSchema = z
  .object({
    ...commonJobShape,
    previewRunId: z.uuid(),
  })
  .strict();

export const ReconcileWorkflowTriggersJobSchema = z
  .object({
    ...commonJobShape,
    workflowId: z.uuid(),
    publishedVersionId: z.uuid(),
  })
  .strict();

export const ExpireArtifactsJobSchema = z
  .object({
    ...commonJobShape,
    artifactId: z.uuid(),
  })
  .strict();

export const DeliverRunFailureNotificationJobSchema = z
  .object({
    ...commonJobShape,
    notificationIntentId: z.uuid(),
  })
  .strict();

export type AdvanceWorkflowRunJob = z.infer<typeof AdvanceWorkflowRunJobSchema>;
export type ExecuteNodeAttemptJob = z.infer<typeof ExecuteNodeAttemptJobSchema>;
export type ExecutePreviewAttemptJob = z.infer<
  typeof ExecutePreviewAttemptJobSchema
>;
export type ReconcilePreviewAttemptJob = z.infer<
  typeof ReconcilePreviewAttemptJobSchema
>;
export type ReconcileUnknownOutcomeJob = z.infer<
  typeof ReconcileUnknownOutcomeJobSchema
>;
export type ReplayWorkflowRunJob = z.infer<typeof ReplayWorkflowRunJobSchema>;
export type SweepExpiredPreviewsJob = z.infer<
  typeof SweepExpiredPreviewsJobSchema
>;
export type ReconcileWorkflowTriggersJob = z.infer<
  typeof ReconcileWorkflowTriggersJobSchema
>;
export type ExpireArtifactsJob = z.infer<typeof ExpireArtifactsJobSchema>;
export type DeliverRunFailureNotificationJob = z.infer<
  typeof DeliverRunFailureNotificationJobSchema
>;

export interface QueueJobDataByName {
  [JOB_NAME.advanceWorkflowRun]: AdvanceWorkflowRunJob;
  [JOB_NAME.executeNodeAttempt]: ExecuteNodeAttemptJob;
  [JOB_NAME.executePreviewAttempt]: ExecutePreviewAttemptJob;
  [JOB_NAME.reconcilePreviewAttempt]: ReconcilePreviewAttemptJob;
  [JOB_NAME.reconcileUnknownOutcome]: ReconcileUnknownOutcomeJob;
  [JOB_NAME.replayWorkflowRun]: ReplayWorkflowRunJob;
  [JOB_NAME.sweepExpiredPreviews]: SweepExpiredPreviewsJob;
  [JOB_NAME.reconcileWorkflowTriggers]: ReconcileWorkflowTriggersJob;
  [JOB_NAME.expireArtifacts]: ExpireArtifactsJob;
  [JOB_NAME.deliverRunFailureNotification]: DeliverRunFailureNotificationJob;
}

export type QueueJob = {
  [Name in JobName]: {
    readonly name: Name;
    readonly data: QueueJobDataByName[Name];
  };
}[JobName];

export const ACTIVE_QUEUE_JOB_NAMES = Object.freeze([
  JOB_NAME.advanceWorkflowRun,
  JOB_NAME.executeNodeAttempt,
  JOB_NAME.executePreviewAttempt,
  JOB_NAME.reconcilePreviewAttempt,
  JOB_NAME.reconcileUnknownOutcome,
  JOB_NAME.replayWorkflowRun,
  JOB_NAME.reconcileWorkflowTriggers,
  JOB_NAME.deliverRunFailureNotification,
] as const satisfies readonly JobName[]);

export type ActiveQueueJobName = (typeof ACTIVE_QUEUE_JOB_NAMES)[number];

const activeQueueJobNames = new Set<JobName>(ACTIVE_QUEUE_JOB_NAMES);

export function isActiveQueueJobName(
  jobName: JobName,
): jobName is ActiveQueueJobName {
  return activeQueueJobNames.has(jobName);
}

const QUEUE_JOB_COMPATIBILITY_REGISTRY = Object.freeze({
  [JOB_NAME.advanceWorkflowRun]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.advanceWorkflowRun],
    schema: AdvanceWorkflowRunJobSchema,
  },
  [JOB_NAME.executeNodeAttempt]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.executeNodeAttempt],
    schema: ExecuteNodeAttemptJobSchema,
  },
  [JOB_NAME.executePreviewAttempt]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.executePreviewAttempt],
    schema: ExecutePreviewAttemptJobSchema,
  },
  [JOB_NAME.reconcilePreviewAttempt]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.reconcilePreviewAttempt],
    schema: ReconcilePreviewAttemptJobSchema,
  },
  [JOB_NAME.reconcileUnknownOutcome]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.reconcileUnknownOutcome],
    schema: ReconcileUnknownOutcomeJobSchema,
  },
  [JOB_NAME.replayWorkflowRun]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.replayWorkflowRun],
    schema: ReplayWorkflowRunJobSchema,
  },
  [JOB_NAME.sweepExpiredPreviews]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.sweepExpiredPreviews],
    schema: SweepExpiredPreviewsJobSchema,
  },
  [JOB_NAME.reconcileWorkflowTriggers]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.reconcileWorkflowTriggers],
    schema: ReconcileWorkflowTriggersJobSchema,
  },
  [JOB_NAME.expireArtifacts]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.expireArtifacts],
    schema: ExpireArtifactsJobSchema,
  },
  [JOB_NAME.deliverRunFailureNotification]: {
    queueName: QUEUE_FOR_JOB[JOB_NAME.deliverRunFailureNotification],
    schema: DeliverRunFailureNotificationJobSchema,
  },
} as const);

for (const entry of Object.values(QUEUE_JOB_COMPATIBILITY_REGISTRY))
  Object.freeze(entry);

export const QUEUE_JOB_REGISTRY = Object.freeze(
  Object.fromEntries(
    ACTIVE_QUEUE_JOB_NAMES.map((jobName) => [
      jobName,
      QUEUE_JOB_COMPATIBILITY_REGISTRY[jobName],
    ]),
  ) as Pick<typeof QUEUE_JOB_COMPATIBILITY_REGISTRY, ActiveQueueJobName>,
);

export class UnknownQueueJobError extends Error {
  public override readonly name = 'UnknownQueueJobError';

  public constructor(jobName: unknown) {
    super(`Unknown queue job name: ${String(jobName)}`);
  }
}

interface QueueJobEnvelope {
  readonly name: unknown;
  readonly data: unknown;
}

function isQueueJobEnvelope(value: unknown): value is QueueJobEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  try {
    const keys = Object.keys(value);
    return (
      keys.length === 2 &&
      Object.hasOwn(value, 'name') &&
      Object.hasOwn(value, 'data') &&
      keys.includes('name') &&
      keys.includes('data')
    );
  } catch {
    return false;
  }
}

export function parseQueueJob(value: unknown): QueueJob {
  if (!isQueueJobEnvelope(value)) {
    throw new TypeError('Queue job must be an object with name and data');
  }

  const registryEntry =
    typeof value.name === 'string' &&
    Object.hasOwn(QUEUE_JOB_COMPATIBILITY_REGISTRY, value.name)
      ? QUEUE_JOB_COMPATIBILITY_REGISTRY[value.name as JobName]
      : undefined;

  if (registryEntry === undefined) {
    throw new UnknownQueueJobError(value.name);
  }

  const parsed = registryEntry.schema.parse(value.data);

  return {
    name: value.name as JobName,
    data: parsed,
  } as QueueJob;
}

export type QueueJobParseResult =
  | { readonly success: true; readonly data: QueueJob }
  | { readonly success: false; readonly error: unknown };

export function safeParseQueueJob(value: unknown): QueueJobParseResult {
  try {
    return { success: true, data: parseQueueJob(value) };
  } catch (error: unknown) {
    return { success: false, error };
  }
}
