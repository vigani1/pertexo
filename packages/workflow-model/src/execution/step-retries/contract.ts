import { z } from 'zod';
import { isWorkflowCallDefinition } from '../../flow/callable/invocation.js';
import { workflowControlOutputKind } from '../../graph/control-output-selection.js';
import { isWorkflowTriggerKey } from '../../graph/triggers.js';

export const STEP_RETRY_LIMITS = Object.freeze({
  maximumAttempts: 5,
  minimumDelayMillis: 1_000,
  maximumDelayMillis: 60_000,
});

export const DEFAULT_STEP_RETRY_SETTINGS = Object.freeze({
  maximumAttempts: 3,
  delayMillis: 1_000,
});

export const stepRetrySettingsSchema = z
  .object({
    maximumAttempts: z
      .number()
      .int()
      .min(1)
      .max(STEP_RETRY_LIMITS.maximumAttempts),
    delayMillis: z
      .number()
      .int()
      .min(STEP_RETRY_LIMITS.minimumDelayMillis)
      .max(STEP_RETRY_LIMITS.maximumDelayMillis)
      .multipleOf(1_000),
  })
  .strict();

export type StepRetrySettings = Readonly<
  z.output<typeof stepRetrySettingsSchema>
>;

/** These outcomes are coordinated rather than retried as executor failures. */
export function supportsStepRetrySettings(
  definition: Readonly<{ key: string; version: number }>,
): boolean {
  return (
    !isWorkflowTriggerKey(definition.key) &&
    workflowControlOutputKind(definition) === undefined &&
    !isWorkflowCallDefinition(definition) &&
    definition.key !== 'core.wait' &&
    definition.key !== 'core.merge' &&
    definition.key !== 'core.terminate'
  );
}
