import {
  MappingRefusalError,
  MappingExecutorFailure,
  type MappingRefusal,
} from './mapping-refusal.js';
import type { CallbackBindings } from '@pertexo/workflow-model';

import {
  isWorkflowTriggerDefinition,
  workspaceVariableValuesSchema,
  type WorkspaceVariableValues,
} from '@pertexo/workflow-model';

import {
  type JsonValue,
  parseWorkflowGraphDraft,
  resolveValueSource,
  type ValueResolution,
  type ValueSource,
  type WorkflowNodeFailureValue,
} from '@pertexo/workflow-model';
import {
  isTemporaryExpressionFailure,
  EXPRESSION_POLICY,
  type ExpressionLimit,
  type ExpressionEvaluator,
} from '@pertexo/workflow-model/server';

import {
  PreviewMappingSourceError,
  WorkflowEngineError,
} from '../workflow-engine.errors.js';

import type { WorkflowExecutableNode } from '../compilation/workflow-executable.js';
import { normalizeBoundedEngineValue } from '../compilation/executable.validation.js';

import { operationError, record } from '../operation-values.js';

import { assertNotAborted, isAbortError } from './admission.js';

export async function resolveMappedNodeInput(
  node: Pick<WorkflowExecutableNode, 'definition' | 'inputMappings'>,
  {
    runInput,
    completedOutputs,
    directUpstream,
    signal,
    expressionEvaluator,
    structuredInputs,
    sourceFailure,
    variables,
    callbacks,
  }: Readonly<{
    runInput: JsonValue;
    completedOutputs: Readonly<Record<string, JsonValue>>;
    directUpstream: ReadonlySet<string>;
    signal: AbortSignal;
    expressionEvaluator?: ExpressionEvaluator | undefined;
    structuredInputs?: Readonly<Record<string, JsonValue>> | undefined;
    sourceFailure?: WorkflowNodeFailureValue | undefined;
    variables?: WorkspaceVariableValues | undefined;
    callbacks?: CallbackBindings | undefined;
  }>,
): Promise<JsonValue> {
  if (isWorkflowTriggerDefinition(node.definition)) return runInput;
  const mapped = Object.create(null) as Record<string, JsonValue>;
  // Mappings resolve independently; their authored order is the input's.
  for (const key of Object.keys(node.inputMappings)) {
    assertNotAborted(signal);
    const source = node.inputMappings[key];
    if (source === undefined) continue;
    const missingUpstreamOutput =
      source.kind === 'node_output' &&
      (!directUpstream.has(source.nodeId) ||
        !Object.hasOwn(completedOutputs, source.nodeId));
    if (missingUpstreamOutput)
      operationError(
        'attempt_invalid',
        'mapping upstream output is incomplete',
      );
    if (
      source.kind === 'node_failure' &&
      sourceFailure?.nodeId !== source.nodeId
    )
      operationError(
        'attempt_invalid',
        'mapping selected source failure is incomplete',
      );
    const resolution = await resolveMappingValue(key, source, {
      runInput,
      completedOutputs,
      directUpstream,
      signal,
      expressionEvaluator,
      structuredInputs,
      sourceFailure,
      variables,
      callbacks,
    });
    if (resolution.kind === 'value') mapped[key] = resolution.value;
  }
  try {
    return normalizeBoundedEngineValue(mapped);
  } catch {
    operationError('attempt_invalid', 'mapped input exceeds runtime limits');
  }
}

/**
 * Resolve one isolated preview node through the production ValueSource path.
 * A test fed by a prior test runs as if that step had just finished: its
 * output is both the run input and the linked step's output.
 */
export async function resolveSingleNodePreviewInput(
  input: Readonly<{
    node: unknown;
    runInput: unknown;
    /** The step whose prior test supplied `runInput`. */
    priorPreviewNodeId?: string | undefined;
    variables?: WorkspaceVariableValues | undefined;
    signal: AbortSignal;
    expressionEvaluator?: ExpressionEvaluator | undefined;
  }>,
): Promise<JsonValue> {
  let node: Pick<WorkflowExecutableNode, 'definition' | 'inputMappings'>;
  let runInput: JsonValue;
  try {
    runInput = normalizeBoundedEngineValue(input.runInput);
    const rawNode = record(
      normalizeBoundedEngineValue(input.node),
      'attempt_invalid',
      'preview node',
    );
    const parsedNode = parseWorkflowGraphDraft({
      edges: [],
      nodes: [{ ...rawNode, position: { x: 0, y: 0 } }],
      settings: {},
    }).nodes[0];
    if (parsedNode === undefined)
      operationError('attempt_invalid', 'preview node is missing');
    node = parsedNode;
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'preview input is invalid',
    );
  }
  const prior = input.priorPreviewNodeId;
  for (const [mappingKey, source] of Object.entries(node.inputMappings))
    if (source.kind === 'node_output' && source.nodeId !== prior)
      throw new PreviewMappingSourceError(mappingKey, source.nodeId);
  return resolveMappedNodeInput(node, {
    runInput: runInput,
    completedOutputs: Object.freeze(
      prior === undefined ? {} : { [prior]: runInput },
    ),
    directUpstream: new Set(prior === undefined ? [] : [prior]),
    signal: input.signal,
    expressionEvaluator: input.expressionEvaluator,
    structuredInputs: undefined,
    sourceFailure: undefined,
    variables: workspaceVariableValuesSchema.parse(input.variables ?? {}),
  });
}

async function resolveMappingValue(
  mappingKey: string,
  source: ValueSource,
  {
    runInput,
    callbacks,
    completedOutputs,
    variables,
    sourceFailure,
    structuredInputs,
    expressionEvaluator,
    signal,
  }: Parameters<typeof resolveMappedNodeInput>[1],
): Promise<ValueResolution> {
  let resolution: ValueResolution;
  try {
    resolution = await resolveValueSource(
      source,
      {
        runInput,
        ...(callbacks === undefined ? {} : { execution: { callbacks } }),
        nodeOutputs: completedOutputs,
        ...(variables === undefined ? {} : { variables }),
        ...(sourceFailure === undefined ? {} : { nodeFailure: sourceFailure }),
        ...(structuredInputs === undefined ? {} : { structuredInputs }),
      },
      expressionEvaluator,
      signal,
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error))
      operationError('attempt_aborted', 'node attempt was aborted');
    operationError('attempt_invalid', 'mapping failed');
  }
  const mappingCanceled =
    resolution.kind === 'error' &&
    (resolution.expression?.code === 'canceled' || signal.aborted);
  if (mappingCanceled)
    operationError('attempt_aborted', 'node attempt was aborted');
  if (resolution.kind === 'error')
    refuseMapping(mappingKey, source, resolution);
  return resolution;
}

function refuseMapping(
  mappingKey: string,
  source: ValueSource,
  resolution: Extract<ValueResolution, { kind: 'error' }>,
): never {
  const field = { mappingKey, sourceKind: source.kind };
  const { expression } = resolution;
  if (expression?.code === 'nonfinite_result')
    throw new MappingExecutorFailure({ ...field, kind: 'nonfinite_result' });
  if (expression !== undefined && isTemporaryExpressionFailure(expression)) {
    // A busy host says nothing about the step's inputs: another try can work.
    if (expression.code === 'timed_out')
      throw new MappingExecutorFailure({
        ...field,
        kind: 'expression_timeout',
        maximumMs: EXPRESSION_POLICY.timeoutMs,
      });
    if (expression.limit === 'pool_capacity')
      throw new MappingExecutorFailure({
        ...field,
        kind: 'pool_capacity',
        maximumQueued: EXPRESSION_POLICY.maxQueued,
      });
    throw new MappingExecutorFailure({
      ...field,
      kind: 'expression_unavailable',
    });
  }

  let diagnostic: MappingRefusal;
  if (source.kind === 'workspace_variable')
    diagnostic = {
      ...field,
      kind: 'variable_missing',
      variable: { kind: 'named', name: source.name },
    };
  else if (expression?.code === 'variable_missing')
    diagnostic = {
      ...field,
      kind: 'variable_missing',
      variable: expression.variable,
    };
  else if (resolution.code === 'invalid_path' && 'path' in source)
    diagnostic = { ...field, kind: 'invalid_path', path: source.path };
  else if (
    expression?.code === 'limit_exceeded' &&
    expression.limit !== undefined
  )
    diagnostic = {
      ...field,
      kind: 'expression_limit',
      limit: expression.limit,
      maximum: expressionLimitMaximum(expression.limit),
    };
  else diagnostic = { ...field, kind: 'expression_failed' };
  throw new MappingRefusalError(mappingFailureCode(resolution), diagnostic);
}

function expressionLimitMaximum(limit: ExpressionLimit): number {
  const maxima: Record<ExpressionLimit, number> = {
    expression_bytes: EXPRESSION_POLICY.expressionBytes,
    ast_depth: EXPRESSION_POLICY.astDepth,
    ast_nodes: EXPRESSION_POLICY.astNodes,
    input_bytes: EXPRESSION_POLICY.inputBytes,
    input_depth: EXPRESSION_POLICY.inputDepth,
    input_members: EXPRESSION_POLICY.inputMembers,
    output_bytes: EXPRESSION_POLICY.outputBytes,
    output_depth: EXPRESSION_POLICY.outputDepth,
    output_members: EXPRESSION_POLICY.outputMembers,
    memory: EXPRESSION_POLICY.processHeapMb,
    pool_capacity: EXPRESSION_POLICY.maxQueued,
  };
  return maxima[limit];
}

function mappingFailureCode(
  resolution: Extract<ValueResolution, { kind: 'error' }>,
) {
  if (
    resolution.code === 'variable_missing' ||
    resolution.expression?.code === 'variable_missing'
  )
    return 'variable_missing';
  if (resolution.expression === undefined) return 'attempt_invalid';
  return resolution.expression.code === 'limit_exceeded'
    ? 'expression_limit_exceeded'
    : 'expression_failed';
}
