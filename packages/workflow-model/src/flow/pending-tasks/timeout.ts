import { z } from 'zod';
import { formValuesSchema } from '../../triggers/forms/values.js';
import { approvalConfigSchema, isHumanTaskDefinition } from './approval.js';
import { taskAudienceSchema, type TaskAudience } from './audience.js';
import { taskDetailsSchema, type TaskContext } from './context.js';

/** The path an Approval or Request input takes when nobody responds in time. */
export const TIMED_OUT_PORT = 'timed_out';

type TaskStep = Readonly<{
  definition?: Readonly<{ key: string; version: number }> | undefined;
  config?: Readonly<Record<string, unknown>> | undefined;
}>;

/** Whether an expired task continues on Timed out instead of failing its step. */
export function continuesOnExpiry(step: TaskStep): boolean {
  if (!isHumanTaskDefinition(step.definition)) return false;
  const choice = approvalConfigSchema.shape.onExpiry.safeParse(
    step.config?.onExpiry,
  );
  return choice.success && choice.data === 'continue';
}

/**
 * The outputs an Approval or Request input offers with its setup: Timed out
 * exists only when the step continues on it. Undefined for any other step.
 */
export function pendingTaskOutputPorts(
  step: TaskStep,
): readonly string[] | undefined {
  if (!isHumanTaskDefinition(step.definition)) return undefined;
  const decided =
    step.definition?.key === 'core.approval'
      ? ['approved', 'rejected']
      : ['out'];
  return continuesOnExpiry(step) ? [...decided, TIMED_OUT_PORT] : decided;
}

export const timedOutTaskOutputSchema = z
  .object({
    timedOut: z.literal(true),
    openedAt: z.iso.datetime(),
    expiredAt: z.iso.datetime(),
    audience: taskAudienceSchema,
    details: taskDetailsSchema.optional(),
    prefill: formValuesSchema.optional(),
  })
  .strict();
export type TimedOutTaskOutput = z.output<typeof timedOutTaskOutputSchema>;

/** What later steps receive from a task nobody answered: when, whom, and what. */
export function timedOutTaskOutput(
  task: Readonly<{
    openedAt: Date;
    expiredAt: Date;
    audience: TaskAudience;
    context: TaskContext;
  }>,
): TimedOutTaskOutput {
  return timedOutTaskOutputSchema.parse({
    timedOut: true,
    openedAt: task.openedAt.toISOString(),
    expiredAt: task.expiredAt.toISOString(),
    audience: task.audience,
    ...task.context,
  });
}
