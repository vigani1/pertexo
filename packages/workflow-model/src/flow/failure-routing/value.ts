import { z } from 'zod';

// The writer's fixed codes per kind: a provider failure (ADR 073), or the
// step's own definite failure — its input or setup, a table refusal, a file it
// can't read, or an error in its code (2026-10-19 amendment). Cancellation,
// unknown outcomes, deadlines and platform limits never route.
const routableCodes = {
  authentication: ['execution.authentication'],
  network: ['execution.network'],
  provider: ['execution.provider'],
  rate_limit: ['execution.rate_limit'],
  timeout: [
    'execution.timeout',
    'execution.expression_timed_out',
    'code.timeout',
  ],
  configuration: [
    'execution.configuration',
    'execution.attempt_invalid',
    'execution.variable_missing',
    'execution.expression_failed',
    'execution.expression_limit_exceeded',
    'execution.file_input',
    'execution.loop_results_too_large',
    'execution.table_not_found',
    'execution.table_invalid_values',
    'execution.table_quota_exceeded',
    'execution.table_conflict',
    'execution.table_key_conflict',
    'execution.table_result_too_large',
    'execution.table_unsafe_filter',
    'utility.invalid_data',
    'utility.text_fields',
    'utility.result_text',
    'utility.xml_name',
    'utility.xml_data',
    'utility.xml_input',
    'utility.xml_root',
    'utility.xml_malformed',
    'utility.xml_dtd',
    'utility.html_selector',
    'utility.crypto_input',
    'utility.hmac_connection',
    'file.create_data',
    'file.create_columns',
    'code.syntax_error',
    'code.output_invalid',
    'code.module_refused',
  ],
  internal: ['code.runtime_error', 'code.memory_limit'],
} as const satisfies Record<string, readonly string[]>;
const routableKinds = Object.keys(
  routableCodes,
) as (keyof typeof routableCodes)[];
export type RoutableFailureKind = keyof typeof routableCodes;
const pendingTaskFailureCodes = [
  'pending_task.expired',
  'pending_task.capacity_exceeded',
] as const;
/** Match the writer's fixed classification codes; syntax alone cannot redact. */
export function isRoutableExecutorFailure(
  value: Readonly<{ errorKind: string; safeErrorCode: string }>,
): value is Readonly<{
  errorKind: RoutableFailureKind;
  safeErrorCode: string;
}> {
  return routableKinds.some(
    (kind) =>
      value.errorKind === kind &&
      (routableCodes[kind] as readonly string[]).includes(value.safeErrorCode),
  );
}
export const workflowFailureClassificationSchema = z
  .object({
    errorKind: z.enum([
      'authentication',
      'network',
      'provider',
      'rate_limit',
      'timeout',
      'configuration',
      'internal',
      'human_task',
    ]),
    safeErrorCode: z.string(),
  })
  .strict()
  .refine(
    (value) =>
      isRoutableExecutorFailure(value) ||
      (value.errorKind === 'human_task' &&
        pendingTaskFailureCodes.some((code) => code === value.safeErrorCode)),
    'Failure code must match its approved executor classification.',
  );
export const workflowNodeFailureValueSchema =
  workflowFailureClassificationSchema.safeExtend({
    nodeId: z.string().min(1),
    invocationKey: z.string().min(1),
    attemptNumber: z.number().int().positive(),
  });
export type WorkflowNodeFailureValue = z.output<
  typeof workflowNodeFailureValueSchema
>;
