import { z } from 'zod';

/**
 * ADR 056: `off` records nothing; `observe` records outcomes and reports
 * workflows that would pause; `enforce` pauses them.
 */
export type WorkflowAutoPauseMode = 'off' | 'observe' | 'enforce';

export type WorkflowAutoPauseConfig = Readonly<{
  mode: WorkflowAutoPauseMode;
  /** Pending run outcomes folded per database call. */
  foldBatchSize: number;
  /** Idle wait between folds once nothing is pending. */
  foldPollMillis: number;
}>;

const schema = z.object({
  mode: z.enum(['off', 'observe', 'enforce']).default('off'),
  foldBatchSize: z.coerce.number().int().min(1).max(1_000).default(500),
  foldPollMillis: z.coerce.number().int().min(100).max(60_000).default(1_000),
});

export function parseWorkflowAutoPauseConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WorkflowAutoPauseConfig {
  return Object.freeze(
    schema.parse({
      mode: environment.WORKFLOW_AUTO_PAUSE,
      foldBatchSize: environment.WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE,
      foldPollMillis: environment.WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS,
    }),
  );
}
