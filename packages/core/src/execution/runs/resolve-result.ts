import { prepareStoredExecutionValue } from '../../runs/values/stored-execution.js';
import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';
import type { RunAdvanceState } from '../../runs/index.js';
import type { CallableResultDecision } from '@pertexo/workflow-engine';
import {
  resolveValueSource,
  validateCallableValue,
  type CallableDeclaration,
} from '@pertexo/workflow-model';
import {
  isTemporaryExpressionFailure,
  type ExpressionEvaluator,
} from '@pertexo/workflow-model/server';

class RunResultUnavailableError extends Error {
  override readonly name = 'RunResultUnavailableError';
}

/** Read retained physical outputs only for the provisional success transition. */
export async function resolveRunResult(
  callable: CallableDeclaration,
  state: Pick<RunAdvanceState, 'readCompletionValues'>,
  signal: AbortSignal,
  evaluator?: ExpressionEvaluator,
): Promise<CallableResultDecision> {
  const source = callable.result;
  const inputs = await state.readCompletionValues(resultOutputIds(source));
  signal.throwIfAborted();
  const groups = new Map<string, typeof inputs.outputs>();
  for (const output of inputs.outputs)
    groups.set(output.nodeId, [...(groups.get(output.nodeId) ?? []), output]);
  const invalidInputs = validateResultInputs(source, inputs, groups);
  if (invalidInputs !== undefined) return invalidInputs;
  const nodeOutputs = Object.fromEntries(
    [...groups.entries()].flatMap(([nodeId, outputs]) =>
      outputs.length === 1 && outputs[0]?.value !== undefined
        ? [[nodeId, outputs[0].value]]
        : [],
    ),
  );
  const resolution = await resolveValueSource(
    source,
    {
      runInput: inputs.runInput ?? null,
      nodeOutputs,
      ...(inputs.variables === undefined
        ? {}
        : { variables: inputs.variables }),
    },
    evaluator,
    signal,
  );
  signal.throwIfAborted();
  // Not the workflow's fault: the advance is delivered again and can work then.
  if (
    resolution.kind === 'error' &&
    resolution.expression !== undefined &&
    resolution.expression.code !== 'timed_out' &&
    isTemporaryExpressionFailure(resolution.expression)
  )
    throw new RunResultUnavailableError(resolution.expression.message);
  if (resolution.kind !== 'value')
    return { kind: 'invalid', reasonCode: resultResolutionFailure(resolution) };
  let prepared: ReturnType<typeof prepareStoredExecutionValue>;
  try {
    prepared = prepareStoredExecutionValue({
      kind: 'inline',
      value: resolution.value,
    });
  } catch (error) {
    if (error instanceof StoredExecutionValueInvalidError)
      return { kind: 'invalid', reasonCode: 'callable_result_bounds' };
    throw error;
  }
  if (
    prepared.value.kind !== 'inline' ||
    Buffer.byteLength(prepared.json) > STORED_EXECUTION_VALUE_LIMITS.inlineBytes
  )
    return { kind: 'invalid', reasonCode: 'callable_result_bounds' };
  if (
    validateCallableValue(callable.resultType, prepared.value.value) !==
    undefined
  )
    return { kind: 'invalid', reasonCode: 'callable_result_invalid' };
  return { kind: 'valid', value: prepared.value.value };
}

type CompletionValues = Awaited<
  ReturnType<RunAdvanceState['readCompletionValues']>
>;
function resultOutputIds(
  source: CallableDeclaration['result'],
): readonly string[] | undefined {
  if (source.kind === 'node_output') return [source.nodeId];
  if (source.kind === 'expression') return undefined;
  return [];
}
function validateResultInputs(
  source: CallableDeclaration['result'],
  inputs: CompletionValues,
  groups: ReadonlyMap<string, CompletionValues['outputs']>,
): Extract<CallableResultDecision, { kind: 'invalid' }> | undefined {
  if (source.kind === 'node_output') {
    const outputs = groups.get(source.nodeId) ?? [];
    if (outputs.length === 0)
      return { kind: 'invalid', reasonCode: 'callable_result_missing' };
    if (outputs.length !== 1)
      return { kind: 'invalid', reasonCode: 'callable_result_ambiguous' };
    if (outputs[0]?.value === undefined)
      return { kind: 'invalid', reasonCode: 'callable_result_invalid' };
  }
  if (
    (source.kind === 'run_input' || source.kind === 'expression') &&
    inputs.runInput === undefined
  )
    return { kind: 'invalid', reasonCode: 'callable_result_missing' };
  return undefined;
}
function resultResolutionFailure(
  resolution: Exclude<
    Awaited<ReturnType<typeof resolveValueSource>>,
    { kind: 'value' }
  >,
): Extract<CallableResultDecision, { kind: 'invalid' }>['reasonCode'] {
  const variableMissing =
    resolution.kind === 'error' &&
    (resolution.code === 'variable_missing' ||
      resolution.expression?.code === 'variable_missing');
  if (variableMissing) return 'callable_result_variable_missing';
  // A fixed reason, so it can't be read as "check your inputs". It doesn't retry
  // like a step does: nothing bounds a redelivered advance that always times out.
  if (
    resolution.kind === 'error' &&
    resolution.expression?.code === 'timed_out'
  )
    return 'callable_result_timed_out';
  if (resolution.kind === 'missing') return 'callable_result_missing';
  return 'callable_result_invalid';
}
