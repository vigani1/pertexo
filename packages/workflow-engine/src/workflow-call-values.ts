import {
  boundedNodeJsonRecordSchema,
  boundedNodeJsonSchema,
} from '@pertexo/node-sdk';
import { types as nodeTypes } from 'node:util';
import { validateCallableValueV1 } from '@pertexo/workflow-model';
import {
  workflowCallableGraphSchemaV2,
  type WorkflowCallableDeclarationV1,
} from '@pertexo/workflow-model/callable-graph-contract';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';
import { resolveValueSource } from '@pertexo/workflow-model/mapping';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { workflowCallPinSchemaV1 } from '@pertexo/workflow-model/workflow-call-contract';
import { WorkflowEngineError } from './errors.js';
import { normalizeBoundedEngineJson } from './compilation/executable-validation.js';

type CallValueResult =
  | Readonly<{ ok: true; value: Readonly<Record<string, JsonValue>> }>
  | Readonly<{
      ok: false;
      reasonCode:
        | 'workflow.child_input_invalid'
        | 'workflow.child_result_missing'
        | 'workflow.child_result_invalid';
    }>;

function retainedDeclaration(value: unknown): WorkflowCallableDeclarationV1 {
  const parsed = workflowCallableGraphSchemaV2.safeParse({
    schemaVersion: 2,
    nodes: [],
    edges: [],
    settings: {},
    callable: value,
  });
  if (!parsed.success || parsed.data.callable === undefined)
    throw new WorkflowEngineError(
      'executable_invalid',
      'retained callable declaration is invalid',
    );
  return parsed.data.callable;
}

function selectedNodeOutput(
  outputs: unknown,
  nodeId: string,
): ReturnType<typeof boundedNodeJsonRecordSchema.safeParse> {
  try {
    if (
      typeof outputs !== 'object' ||
      outputs === null ||
      Array.isArray(outputs) ||
      nodeTypes.isProxy(outputs) ||
      (Object.getPrototypeOf(outputs) !== Object.prototype &&
        Object.getPrototypeOf(outputs) !== null)
    )
      return boundedNodeJsonRecordSchema.safeParse(undefined);
    const field = Object.getOwnPropertyDescriptor(outputs, nodeId);
    if (field === undefined) return boundedNodeJsonRecordSchema.safeParse({});
    if (!('value' in field) || !field.enumerable)
      return boundedNodeJsonRecordSchema.safeParse(undefined);
    const selected = boundedNodeJsonSchema.safeParse(field.value);
    if (!selected.success)
      return boundedNodeJsonRecordSchema.safeParse(undefined);
    return {
      success: true,
      data: Object.freeze({ [nodeId]: selected.data }),
    };
  } catch {
    return boundedNodeJsonRecordSchema.safeParse(undefined);
  }
}

function assertCallResultNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new WorkflowEngineError('attempt_aborted', 'call result was aborted');
}

/** Validate against the exact retained declaration before any child intent. */
export function validateWorkflowCallInputV1(input: {
  readonly pin: unknown;
  readonly declaration: WorkflowCallableDeclarationV1;
  readonly value: unknown;
}): CallValueResult {
  const declaration = retainedDeclaration(input.declaration);
  let pin;
  try {
    pin = workflowCallPinSchemaV1.parse(normalizeBoundedEngineJson(input.pin));
  } catch {
    throw new WorkflowEngineError(
      'executable_invalid',
      'callable pin is invalid',
    );
  }
  if (
    workflowCallableContractIdentityV1(declaration) !==
    pin.callableContractIdentity
  )
    throw new WorkflowEngineError(
      'executable_invalid',
      'retained callable declaration does not match its pin',
    );
  const value = boundedNodeJsonRecordSchema.safeParse(input.value);
  if (
    !value.success ||
    !validateCallableValueV1(declaration.input, value.data).ok
  )
    return { ok: false, reasonCode: 'workflow.child_input_invalid' };
  return { ok: true, value: value.data };
}

/** No fallback result: missing/skipped selection and invalid types fail definitely. */
export async function resolveWorkflowCallableResultV1(input: {
  readonly declaration: WorkflowCallableDeclarationV1;
  readonly runInput: JsonValue;
  readonly nodeOutputs: Readonly<Record<string, JsonValue>>;
  readonly expressionEvaluator?: ExpressionEvaluator;
  readonly signal: AbortSignal;
}): Promise<CallValueResult> {
  assertCallResultNotAborted(input.signal);
  const declaration = retainedDeclaration(input.declaration);
  const source = declaration.resultSelector;
  const runInput = boundedNodeJsonSchema.safeParse(
    source.kind === 'run_input' || source.kind === 'expression'
      ? input.runInput
      : null,
  );
  // A direct selector does not materialize unrelated historical outputs or
  // impose an accidental aggregate limit on them. Expressions retain the
  // existing bounded expression context contract.
  const nodeOutputs =
    source.kind === 'node_output'
      ? selectedNodeOutput(input.nodeOutputs, source.nodeId)
      : boundedNodeJsonRecordSchema.safeParse(
          source.kind === 'expression' ? input.nodeOutputs : {},
        );
  if (!runInput.success || !nodeOutputs.success)
    return { ok: false, reasonCode: 'workflow.child_result_invalid' };
  let resolved;
  try {
    resolved = await resolveValueSource(
      declaration.resultSelector,
      { runInput: runInput.data, nodeOutputs: nodeOutputs.data },
      input.expressionEvaluator,
      input.signal,
    );
  } catch (error) {
    assertCallResultNotAborted(input.signal);
    throw error;
  }
  assertCallResultNotAborted(input.signal);
  if (resolved.kind === 'missing')
    return { ok: false, reasonCode: 'workflow.child_result_missing' };
  if (resolved.kind === 'error')
    return { ok: false, reasonCode: 'workflow.child_result_invalid' };
  const value = boundedNodeJsonRecordSchema.safeParse(resolved.value);
  if (
    !value.success ||
    !validateCallableValueV1(declaration.result, value.data).ok
  )
    return { ok: false, reasonCode: 'workflow.child_result_invalid' };
  return { ok: true, value: value.data };
}
