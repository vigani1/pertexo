import { z } from 'zod';

export type WorkflowAutoPauseConfig = Readonly<{
  /** Pending run outcomes folded per database call. */
  foldBatchSize: number;
  /** Idle wait between folds once nothing is pending. */
  foldPollMillis: number;
}>;

const schema = z.object({
  foldBatchSize: z.coerce.number().int().min(1).max(1_000).default(500),
  foldPollMillis: z.coerce.number().int().min(100).max(60_000).default(1_000),
});

export function parseWorkflowAutoPauseConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WorkflowAutoPauseConfig {
  return Object.freeze(
    schema.parse({
      foldBatchSize: environment.WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE,
      foldPollMillis: environment.WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS,
    }),
  );
}
