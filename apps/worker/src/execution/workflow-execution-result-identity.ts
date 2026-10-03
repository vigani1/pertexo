import { createHash } from 'node:crypto';
import { serializeWorkflowExecutionJsonValueV3 } from '@pertexo/database/execution';
import { valueSourceSchema } from '@pertexo/workflow-model/graph-contract';
import { z } from 'zod';
import { metadataSchema } from './workflow-execution-value-contract.js';

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
    value: metadataSchema.omit({ artifactId: true, workspaceId: true }),
  })
  .strict();

export type WorkflowExecutionResultIdentityInputV1 = z.input<
  typeof identitySchema
>;

/** Pure metadata identity; never proves accepted source or producer authority. */
export function createWorkflowExecutionResultIdentityV1(
  input: unknown,
): string {
  // The existing encoder rejects hostile envelopes and bounds traversal before
  // structural parsing. Its selected spelling is also the final byte owner.
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
  const bytes = serializeWorkflowExecutionJsonValueV3({
    ...record,
    schemaVersion: 1,
    slot: 'run_result',
  });
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
