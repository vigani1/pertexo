import { z } from 'zod';

/** Repository-owned run failures; arbitrary historical summaries stay private. */
export const RUN_FAILURE_CODES = [
  'execution.run_state_invalid',
  'execution.checkpoint_missing',
  'callable_result_missing',
  'callable_result_variable_missing',
  'callable_result_ambiguous',
  'callable_result_invalid',
  'callable_result_timed_out',
  'callable_result_bounds',
] as const;
export const runFailureCodeSchema = z.enum(RUN_FAILURE_CODES);
export type RunFailureCode = z.output<typeof runFailureCodeSchema>;
export type CallableResultFailureCode = Extract<
  RunFailureCode,
  `callable_result_${string}`
>;
