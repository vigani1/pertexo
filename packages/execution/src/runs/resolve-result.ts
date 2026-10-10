import {
  prepareStoredExecutionValue,
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/database/platform';
import type { RunAdvanceState } from '@pertexo/database/runs';
import type { CallableResultDecision } from '@pertexo/workflow-engine';
import {
  resolveValueSource,
  validateCallableValue,
  type CallableDeclaration,
} from '@pertexo/workflow-model';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

/** Read retained physical outputs only for the provisional success transition. */
export async function resolveRunResult(
  callable: CallableDeclaration,
  state: Pick<RunAdvanceState, 'readCompletionValues'>,
  signal: AbortSignal,
  evaluator?: ExpressionEvaluator,
): Promise<CallableResultDecision> {
  const source = callable.result;
  const inputs = await state.readCompletionValues(
    source.kind === 'node_output'
      ? [source.nodeId]
      : source.kind === 'expression'
        ? undefined
        : [],
  );
  signal.throwIfAborted();
  const groups = new Map<string, typeof inputs.outputs>();
  for (const output of inputs.outputs)
    groups.set(output.nodeId, [...(groups.get(output.nodeId) ?? []), output]);
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
    },
    evaluator,
    signal,
  );
  signal.throwIfAborted();
  if (resolution.kind !== 'value')
    return {
      kind: 'invalid',
      reasonCode:
        resolution.kind === 'missing'
          ? 'callable_result_missing'
          : 'callable_result_invalid',
    };
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
