import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import {
  inspectExpressionNodeOutputReferences,
  type ExpressionEvaluator,
} from '@pertexo/workflow-model/expressions';
import { parseCheckpoint } from '../checkpoint/checkpoint.js';
import { ownCompletedFields } from '../completed-output-fields.js';
import type { CompiledWorkflowExecutableV3 } from '../compilation/executable-v3.js';
import { normalizeBoundedEngineJson } from '../executable-workflow.js';
import { operationError, record } from '../operation-values.js';
import type {
  InvocationState,
  OutputReference,
  WorkflowTransitionPlan,
} from '../types.js';
import { resolveWorkflowCallableResultV1 } from '../workflow-call-values.js';

/** Hydrated by existing protected input/output owners outside commit locks. */
export interface WorkflowCallableCompletionMaterial {
  readonly runInput: unknown;
  readonly outputs: unknown;
  readonly expressionEvaluator?: ExpressionEvaluator;
}

type CompletionSource = InvocationState & Readonly<{ output: OutputReference }>;

function completionMaterial(
  input: WorkflowCallableCompletionMaterial,
): WorkflowCallableCompletionMaterial {
  const fields = ownCompletedFields(input, 'observation_invalid');
  if (
    Array.isArray(input) ||
    !['runInput', 'outputs'].every((key) => Object.hasOwn(fields, key)) ||
    Object.keys(fields).some(
      (key) => !['runInput', 'outputs', 'expressionEvaluator'].includes(key),
    )
  )
    operationError(
      'observation_invalid',
      'callable completion material is invalid',
    );
  return {
    runInput: fields.runInput,
    outputs: fields.outputs,
    ...(fields.expressionEvaluator === undefined
      ? {}
      : {
          expressionEvaluator:
            fields.expressionEvaluator as ExpressionEvaluator,
        }),
  };
}

function selectedNodes(
  declaration: WorkflowCallableDeclarationV1,
  executable: CompiledWorkflowExecutableV3,
): readonly string[] {
  const source = declaration.resultSelector;
  if (source.kind === 'node_output') return [source.nodeId];
  if (source.kind !== 'expression') return [];
  const inspection = inspectExpressionNodeOutputReferences(
    source.expression,
    source.policyVersion,
  );
  if (inspection.kind !== 'valid')
    operationError(
      'workflow_identity_invalid',
      'callable result expression is invalid',
    );
  return inspection.nodeIds === 'all'
    ? executable.envelope.graph.nodes.map(({ id }) => id)
    : inspection.nodeIds;
}

function uniqueSources(
  nodeIds: readonly string[],
  plan: WorkflowTransitionPlan,
): readonly CompletionSource[] | undefined {
  const sources: CompletionSource[] = [];
  for (const nodeId of nodeIds) {
    const matching = plan.checkpoint.invocations.filter(
      (invocation) =>
        invocation.nodeId === nodeId && invocation.status === 'succeeded',
    );
    const source = matching[0];
    if (matching.length !== 1 || source?.output === undefined) return undefined;
    sources.push({ ...source, output: source.output });
  }
  return sources;
}

function completionDescriptors(value: unknown): readonly Readonly<{
  invocationKey: string;
  output: JsonValue;
  value: unknown;
}>[] {
  try {
    const fields = ownCompletedFields(value, 'observation_invalid');
    if (!Array.isArray(value))
      operationError(
        'observation_invalid',
        'callable result sources must be an array',
      );
    const descriptors = Object.values(fields).map((candidate) => {
      if (Array.isArray(candidate))
        operationError(
          'observation_invalid',
          'callable result source is invalid',
        );
      const descriptor = ownCompletedFields(candidate, 'observation_invalid');
      if (
        Object.keys(descriptor).length !== 3 ||
        !['invocationKey', 'output', 'value'].every((key) =>
          Object.hasOwn(descriptor, key),
        )
      )
        operationError(
          'observation_invalid',
          'callable result source is invalid',
        );
      return descriptor;
    });
    const metadata = normalizeBoundedEngineJson(
      descriptors.map(({ invocationKey, output }) => ({
        invocationKey,
        output,
      })),
    );
    if (!Array.isArray(metadata))
      operationError(
        'observation_invalid',
        'callable result metadata is invalid',
      );
    return metadata.map((item, index) => {
      const descriptor = record(
        item as JsonValue,
        'observation_invalid',
        'callable result source',
      );
      if (
        typeof descriptor.invocationKey !== 'string' ||
        descriptor.output === undefined
      )
        operationError(
          'observation_invalid',
          'callable result source identity is invalid',
        );
      return {
        invocationKey: descriptor.invocationKey,
        output: descriptor.output,
        value: descriptors[index]?.value,
      };
    });
  } catch {
    operationError(
      'observation_invalid',
      'callable result source material is invalid',
    );
  }
}

function hydrateSources(
  material: WorkflowCallableCompletionMaterial,
  sources: readonly CompletionSource[],
  plan: WorkflowTransitionPlan,
): Readonly<Record<string, JsonValue>> | undefined {
  const descriptors = completionDescriptors(material.outputs);
  const invocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const indexed = new Map<string, (typeof descriptors)[number]>();
  // Verify all source identities before traversing any hydrated value.
  for (const descriptor of descriptors) {
    const invocation = invocations.get(descriptor.invocationKey);
    if (
      indexed.has(descriptor.invocationKey) ||
      invocation?.status !== 'succeeded' ||
      invocation.output === undefined ||
      canonicalJson(descriptor.output) !== canonicalJson(invocation.output)
    )
      operationError(
        'observation_invalid',
        'callable result source does not match durable output',
      );
    indexed.set(descriptor.invocationKey, descriptor);
  }
  const outputs = Object.create(null) as Record<string, JsonValue>;
  for (const source of sources) {
    const descriptor = indexed.get(source.invocationKey);
    if (descriptor === undefined)
      operationError(
        'observation_invalid',
        'callable result source hydration is missing',
      );
    const parsed = boundedNodeJsonSchema.safeParse(descriptor.value);
    if (!parsed.success) return undefined;
    outputs[source.nodeId] = parsed.data;
  }
  return outputs;
}

function failedResult(
  plan: WorkflowTransitionPlan,
  reasonCode: 'workflow.child_result_invalid' | 'workflow.child_result_missing',
): WorkflowTransitionPlan {
  return {
    ...plan,
    checkpoint: parseCheckpoint({ ...plan.checkpoint, runStatus: 'failed' }),
    events: plan.events.map((event) =>
      event.name === 'run.succeeded'
        ? { ...event, name: 'run.failed' as const, reasonCode }
        : event,
    ),
    callableResult: { kind: 'failed', reasonCode },
  };
}

/** Finish the one existing transition; never fabricate an attempt or second CAS. */
export async function completeCallableTransition(
  executable: CompiledWorkflowExecutableV3,
  plan: WorkflowTransitionPlan,
  material: WorkflowCallableCompletionMaterial | undefined,
  signal: AbortSignal,
): Promise<WorkflowTransitionPlan> {
  const declaration = executable.envelope.graph.callable;
  if (
    declaration === undefined ||
    !plan.events.some(({ name }) => name === 'run.succeeded')
  )
    return plan;
  const nodeIds = selectedNodes(declaration, executable);
  const rootNodeIds = new Set(
    executable.envelope.graph.nodes.map(({ id }) => id),
  );
  if (nodeIds.some((id) => !rootNodeIds.has(id)))
    return failedResult(plan, 'workflow.child_result_invalid');
  const sources = uniqueSources(nodeIds, plan);
  if (sources === undefined)
    return failedResult(plan, 'workflow.child_result_invalid');
  const selector = declaration.resultSelector;
  if (selector.kind !== 'literal' && material === undefined)
    operationError(
      'observation_invalid',
      'callable completion material is missing',
    );
  const hydrated =
    material === undefined ? undefined : completionMaterial(material);
  const outputs =
    hydrated === undefined ? {} : hydrateSources(hydrated, sources, plan);
  if (outputs === undefined)
    return failedResult(plan, 'workflow.child_result_invalid');
  const requiresInput =
    selector.kind === 'run_input' || selector.kind === 'expression';
  const runInput = boundedNodeJsonSchema.safeParse(
    requiresInput ? hydrated?.runInput : null,
  );
  if (!runInput.success)
    return failedResult(plan, 'workflow.child_result_invalid');
  if (
    selector.kind === 'expression' &&
    hydrated?.expressionEvaluator === undefined
  )
    operationError(
      'observation_invalid',
      'callable result evaluator is unavailable',
    );
  const result = await resolveWorkflowCallableResultV1({
    declaration,
    runInput: runInput.data,
    nodeOutputs: outputs,
    signal,
    ...(hydrated?.expressionEvaluator === undefined
      ? {}
      : { expressionEvaluator: hydrated.expressionEvaluator }),
  });
  if (!result.ok)
    return failedResult(
      plan,
      result.reasonCode === 'workflow.child_result_missing'
        ? result.reasonCode
        : 'workflow.child_result_invalid',
    );
  return {
    ...plan,
    callableResult: {
      kind: 'succeeded',
      value: result.value,
      sources: sources.map(({ invocationKey, output }) => ({
        invocationKey,
        output,
      })),
    },
  };
}
