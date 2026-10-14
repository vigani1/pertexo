import { z } from 'zod';

const routableKinds = [
  'authentication',
  'network',
  'provider',
  'rate_limit',
  'timeout',
] as const;
export type RoutableFailureKind = (typeof routableKinds)[number];
/** Match the writer's fixed classification codes; syntax alone cannot redact. */
export function isRoutableExecutorFailure(
  value: Readonly<{ errorKind: string; safeErrorCode: string }>,
): value is Readonly<{
  errorKind: RoutableFailureKind;
  safeErrorCode: string;
}> {
  return routableKinds.some(
    (kind) =>
      value.errorKind === kind && value.safeErrorCode === `execution.${kind}`,
  );
}
export const workflowNodeFailureValueSchema = z
  .object({
    nodeId: z.string().min(1),
    invocationKey: z.string().min(1),
    attemptNumber: z.number().int().positive(),
    errorKind: z.enum(routableKinds),
    safeErrorCode: z.string(),
  })
  .strict()
  .refine(
    isRoutableExecutorFailure,
    'Failure code must match its approved executor classification.',
  );
export type WorkflowNodeFailureValue = z.output<
  typeof workflowNodeFailureValueSchema
>;
