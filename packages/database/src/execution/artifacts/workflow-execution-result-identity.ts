import { createHash } from 'node:crypto';
import { valueSourceSchema } from '@pertexo/workflow-model/graph-contract';
import { z } from 'zod';
import { serializeWorkflowExecutionJsonValueV3 } from '../stored-execution-value.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from './execution-value-representation.js';

const identitySchema = z
  .object({
    workspaceId: z.uuid(),
    runId: z.uuid(),
    workflowVersionId: z.uuid(),
    delivery: z
      .object({
        outboxEventId: z.uuid(),
        payloadChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    expectedRevision: z.number().int().nonnegative(),
    resultRevision: z.number().int().positive(),
    resultSelector: valueSourceSchema,
    sources: z
      .array(
        z
          .object({
            invocationKey: z.string().min(1).max(256),
            output: z.discriminatedUnion('kind', [
              z
                .object({ kind: z.literal('inline'), attemptId: z.uuid() })
                .strict(),
              z
                .object({ kind: z.literal('artifact'), artifactId: z.uuid() })
                .strict(),
              z
                .object({
                  kind: z.literal('workflow_call'),
                  invocationKey: z.string().min(1).max(256),
                  childRunId: z.uuid(),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .max(1_000),
    value: z
      .object({
        byteLength: z.number().int().min(1).max(1_048_576),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        mediaType: z.literal(WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1),
      })
      .strict(),
  })
  .strict();

export type WorkflowExecutionResultIdentityInputV1 = z.input<
  typeof identitySchema
>;

/** Content binding only; the protected acceptance owner proves actual authority. */
export function prepareWorkflowExecutionResultIdentityV1(
  input: unknown,
): Readonly<{
  identity: string;
  serializedIdentity: string;
}> {
  const record = identitySchema.parse(
    JSON.parse(serializeWorkflowExecutionJsonValueV3(input)) as unknown,
  );
  if (record.resultRevision !== record.expectedRevision + 1)
    throw new TypeError('Native result identity revisions do not agree');
  const invocations = new Set<string>();
  for (const source of record.sources) {
    if (
      invocations.has(source.invocationKey) ||
      (source.output.kind === 'workflow_call' &&
        source.output.invocationKey !== source.invocationKey)
    )
      throw new TypeError('Native result identity source scope does not agree');
    invocations.add(source.invocationKey);
  }
  const serializedIdentity = serializeWorkflowExecutionJsonValueV3({
    ...record,
    schemaVersion: 1,
    slot: 'run_result',
  });
  return Object.freeze({
    identity: createHash('sha256')
      .update(serializedIdentity, 'utf8')
      .digest('hex'),
    serializedIdentity,
  });
}

export function createWorkflowExecutionResultIdentityV1(
  input: unknown,
): string {
  return prepareWorkflowExecutionResultIdentityV1(input).identity;
}
