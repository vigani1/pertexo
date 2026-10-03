import { z } from 'zod';

import { parseWorkflowExecutionValueSnapshot } from './node-attempt-call-input-record.js';
import { NODE_ATTEMPT_INPUT_LIMITS } from './node-attempt-run-store-contract.js';

const nodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const invocationKey = z.string().min(1).max(256);
const scopeSchema = z.object({
  workspaceId: z.uuid(),
  runId: z.uuid(),
  workflowVersionId: z.uuid(),
});
const contextSchema = scopeSchema
  .extend({
    nodeId,
    invocationKey,
    admissionKind: z.enum(['execute', 'retry', 'wait_resume']),
    graphSchemaVersion: z.literal(2),
    executableSchemaVersion: z.literal(3),
    executableChecksum: z.string().regex(/^wf:v3:sha256:[0-9a-f]{64}$/u),
    checkpointSchemaVersion: z.literal(3),
    runInputPresent: z.boolean(),
    upstreamNodeOutputs: z
      .array(z.object({ nodeId, invocationKey }).strict())
      .max(NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs)
      .refine(
        (outputs) =>
          new Set(outputs.map((output) => output.invocationKey)).size ===
          outputs.length,
      ),
  })
  .strict();
const runInputSchema = z
  .object({
    slot: z.literal('run_input'),
    source: scopeSchema
      .extend({
        kind: z.literal('run_input'),
        provenanceId: z.uuid(),
      })
      .strict(),
    snapshot: z.unknown(),
  })
  .strict();
const physicalSourceSchema = scopeSchema
  .extend({
    kind: z.literal('physical_output'),
    provenanceId: z.uuid(),
    nodeId,
    invocationKey,
    attemptId: z.uuid(),
  })
  .strict();
const logicalSourceSchema = z
  .object({
    kind: z.literal('workflow_call_result'),
    workspaceId: z.uuid(),
    provenanceId: z.uuid(),
    parentRunId: z.uuid(),
    parentWorkflowVersionId: z.uuid(),
    childRunId: z.uuid(),
    childWorkflowVersionId: z.uuid(),
    nodeId,
    invocationKey,
  })
  .strict();
const upstreamOutputSchema = z
  .object({
    slot: z.literal('upstream_output'),
    source: z.discriminatedUnion('kind', [
      physicalSourceSchema,
      logicalSourceSchema,
    ]),
    snapshot: z.unknown(),
  })
  .strict();
const resumeOutputSchema = z
  .object({
    slot: z.literal('wait_resume_output'),
    source: physicalSourceSchema,
    snapshot: z.unknown(),
  })
  .strict();
const sourceSchema = z.discriminatedUnion('slot', [
  runInputSchema,
  upstreamOutputSchema,
  resumeOutputSchema,
]);

type Snapshot = ReturnType<typeof parseWorkflowExecutionValueSnapshot>;
export type NativeNodeAttemptValueSource =
  | Readonly<{
      slot: 'run_input';
      source: Readonly<z.output<typeof runInputSchema>['source']>;
      snapshot: Snapshot;
    }>
  | Readonly<{
      slot: 'upstream_output';
      source: Readonly<z.output<typeof upstreamOutputSchema>['source']>;
      snapshot: Snapshot;
    }>
  | Readonly<{
      slot: 'wait_resume_output';
      source: Readonly<z.output<typeof physicalSourceSchema>>;
      snapshot: Snapshot;
    }>;
export type NativeNodeAttemptValueSources = Readonly<{
  runInput: Extract<NativeNodeAttemptValueSource, { slot: 'run_input' }> | null;
  resumeOutput?: Extract<
    NativeNodeAttemptValueSource,
    { slot: 'wait_resume_output' }
  >;
  completedNodeOutputs: readonly Extract<
    NativeNodeAttemptValueSource,
    { slot: 'upstream_output' }
  >[];
}>;

/**
 * Parse protected loader projections, not arbitrary decoded input values.
 * Shape/byte verification is not accepted provenance or consumption authority:
 * the existing SQL read owner must establish both before emitting these records.
 */
export function parseNativeNodeAttemptValueSources(
  contextValue: unknown,
  sourcesValue: unknown,
): NativeNodeAttemptValueSources {
  const context = contextSchema.parse(contextValue);
  if (
    !Array.isArray(sourcesValue) ||
    sourcesValue.length > NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs + 2
  )
    throw new TypeError(
      'Native execution value sources exceed the bounded input projection',
    );
  const sources = z
    .array(sourceSchema)
    .max(NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs + 2)
    .parse(sourcesValue);
  let runInput:
    NonNullable<NativeNodeAttemptValueSources['runInput']> | undefined;
  let resumeOutput: NativeNodeAttemptValueSources['resumeOutput'];
  const outputs = new Map<
    string,
    Extract<NativeNodeAttemptValueSource, { slot: 'upstream_output' }>
  >();
  for (const input of sources) {
    const source = input.source;
    const sourceRunId =
      source.kind === 'workflow_call_result'
        ? source.parentRunId
        : source.runId;
    const sourceVersionId =
      source.kind === 'workflow_call_result'
        ? source.parentWorkflowVersionId
        : source.workflowVersionId;
    if (
      source.workspaceId !== context.workspaceId ||
      sourceRunId !== context.runId ||
      sourceVersionId !== context.workflowVersionId
    )
      throw new TypeError('Native execution value source scope does not agree');
    Object.freeze(input.source);
    const projected = Object.freeze({
      ...input,
      snapshot: parseWorkflowExecutionValueSnapshot(input.snapshot),
    });
    if (projected.slot === 'run_input') {
      if (runInput !== undefined)
        throw new TypeError('Native execution value slot is duplicated');
      runInput = projected;
    } else if (projected.slot === 'wait_resume_output') {
      if (resumeOutput !== undefined)
        throw new TypeError('Native execution value slot is duplicated');
      if (
        context.admissionKind !== 'wait_resume' ||
        projected.source.nodeId !== context.nodeId ||
        projected.source.invocationKey !== context.invocationKey
      )
        throw new TypeError('Native Wait resume value source is out of scope');
      resumeOutput = projected;
    } else {
      if (outputs.has(projected.source.invocationKey))
        throw new TypeError('Native execution value slot is duplicated');
      outputs.set(projected.source.invocationKey, projected);
    }
  }
  const completedNodeOutputs = context.upstreamNodeOutputs.map((expected) => {
    const output = outputs.get(expected.invocationKey);
    if (
      output?.slot !== 'upstream_output' ||
      output.source.nodeId !== expected.nodeId
    )
      throw new TypeError(
        'Native upstream value source is missing or out of scope',
      );
    return output;
  });
  if (outputs.size !== completedNodeOutputs.length)
    throw new TypeError(
      'Native upstream value source is missing or out of scope',
    );
  if (context.admissionKind === 'wait_resume' && resumeOutput === undefined)
    throw new TypeError('Native Wait resume value source is missing');
  if (context.runInputPresent !== (runInput !== undefined))
    throw new TypeError(
      'Native run input value source is missing or unexpected',
    );
  return Object.freeze({
    runInput: runInput ?? null,
    completedNodeOutputs: Object.freeze(completedNodeOutputs),
    ...(resumeOutput === undefined ? {} : { resumeOutput }),
  });
}
