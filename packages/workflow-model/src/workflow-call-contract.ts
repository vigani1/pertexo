import { z } from 'zod';

/** Exact immutable child identity, scoped to the owning workspace by the use case. */
export const workflowCallPinSchemaV1 = z
  .object({
    workflowId: z.uuid(),
    versionId: z.uuid(),
    checksum: z.string().regex(/^wf:v3:sha256:[0-9a-f]{64}$/u),
    callableContractIdentity: z
      .string()
      .regex(/^callable:v1:sha256:[0-9a-f]{64}$/u),
  })
  .strict();

export type WorkflowCallPinV1 = z.infer<typeof workflowCallPinSchemaV1>;

/** Required executable policy: never an ambient fallback for retained runs. */
export const WORKFLOW_CALL_FAMILY_POLICY_V1 = Object.freeze({
  schemaVersion: 1 as const,
  defaultMaxRunDurationMs: 3_600_000 as const,
  maxCallDepth: 4 as const,
  maxChildRuns: 64 as const,
  maxExpandedInvocations: 1_000 as const,
});

export const workflowCallFamilyPolicySchemaV1 = z
  .object({
    schemaVersion: z.literal(WORKFLOW_CALL_FAMILY_POLICY_V1.schemaVersion),
    defaultMaxRunDurationMs: z.literal(
      WORKFLOW_CALL_FAMILY_POLICY_V1.defaultMaxRunDurationMs,
    ),
    maxCallDepth: z.literal(WORKFLOW_CALL_FAMILY_POLICY_V1.maxCallDepth),
    maxChildRuns: z.literal(WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns),
    maxExpandedInvocations: z.literal(
      WORKFLOW_CALL_FAMILY_POLICY_V1.maxExpandedInvocations,
    ),
  })
  .strict();

export type WorkflowCallFamilyPolicyV1 = z.infer<
  typeof workflowCallFamilyPolicySchemaV1
>;

/** Work stopped without authority to fabricate a workflow result or control fact. */
export const callableValueWorkStopSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('canceled') }).strict(),
  z.object({ kind: z.literal('timed_out') }).strict(),
  z
    .object({
      kind: z.literal('stale'),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('context_aborted') }).strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: z.enum([
        'control_read_failed',
        'value_work_timeout',
        'source_read_failed',
      ]),
    })
    .strict(),
]);

export type CallableValueWorkStop = z.infer<typeof callableValueWorkStopSchema>;

export class CallableCompletionStoppedError extends Error {
  public override readonly name = 'CallableCompletionStoppedError';
  public constructor(readonly stop: CallableValueWorkStop) {
    super(`Callable value work stopped: ${stop.kind}`);
  }
}
