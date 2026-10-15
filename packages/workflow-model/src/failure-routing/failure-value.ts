import { z } from 'zod';

const routableKinds = [
  'authentication',
  'network',
  'provider',
  'rate_limit',
  'timeout',
] as const;
export type RoutableFailureKind = (typeof routableKinds)[number];
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
      value.errorKind === kind && value.safeErrorCode === `execution.${kind}`,
  );
}
export const workflowNodeFailureValueSchema = z
  .object({
    nodeId: z.string().min(1),
    invocationKey: z.string().min(1),
    attemptNumber: z.number().int().positive(),
    errorKind: z.enum([...routableKinds, 'human_task']),
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
export type WorkflowNodeFailureValue = z.output<
  typeof workflowNodeFailureValueSchema
>;
