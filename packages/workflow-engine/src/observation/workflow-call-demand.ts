import type { ValueSource } from '@pertexo/workflow-model/graph-contract';
import {
  callableValueWorkStopSchema,
  type CallableValueWorkStop,
} from '@pertexo/workflow-model/workflow-call-contract';
import { ownCompletedFields } from '../completed-output-fields.js';
import { normalizeBoundedEngineJson } from '../executable-workflow.js';
import { operationError } from '../operation-values.js';
import type { OutputReference } from '../types.js';
import type { WorkflowCallableCompletionMaterial } from './workflow-call-completion.js';

export type CallableMaterialDemand = Readonly<{
  expectedRevision: number;
  resultSelector: ValueSource;
  requiresRunInput: boolean;
  sources: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
    output: OutputReference;
  }>[];
}>;

export type CallableMaterialDemandResult =
  | Readonly<{
      kind: 'ready';
      material: Pick<
        WorkflowCallableCompletionMaterial,
        'runInput' | 'outputs'
      >;
    }>
  | Readonly<{ kind: 'invalid_context' }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>;

export type LoadCallableCompletion = (
  demand: CallableMaterialDemand,
  signal: AbortSignal,
) => Promise<CallableMaterialDemandResult>;

export class CallableCompletionStoppedError extends Error {
  public override readonly name = 'CallableCompletionStoppedError';
  public constructor(readonly stop: CallableValueWorkStop) {
    super(`Callable value work stopped: ${stop.kind}`);
  }
}

function assertDemandNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new CallableCompletionStoppedError({ kind: 'context_aborted' });
}

/** Validate adapter envelopes before accessing material; never accept its evaluator. */
export async function demandCallableMaterial(
  load: LoadCallableCompletion,
  demand: CallableMaterialDemand,
  signal: AbortSignal,
): Promise<
  Pick<WorkflowCallableCompletionMaterial, 'runInput' | 'outputs'> | undefined
> {
  assertDemandNotAborted(signal);
  // The provider may own mutable request data, but never aliases checkpoint facts.
  const fields = ownCompletedFields(
    await load(structuredClone(demand), signal),
    'observation_invalid',
  );
  if (
    fields.kind === 'stopped' &&
    Object.keys(fields).length === 2 &&
    Object.hasOwn(fields, 'stop')
  ) {
    const stop = callableValueWorkStopSchema.safeParse(
      normalizeBoundedEngineJson(fields.stop),
    );
    if (!stop.success)
      operationError('observation_invalid', 'callable demand stop is invalid');
    throw new CallableCompletionStoppedError(Object.freeze(stop.data));
  }
  assertDemandNotAborted(signal);
  if (fields.kind === 'invalid_context' && Object.keys(fields).length === 1)
    return undefined;
  if (
    fields.kind !== 'ready' ||
    Object.keys(fields).length !== 2 ||
    !Object.hasOwn(fields, 'material')
  )
    operationError('observation_invalid', 'callable demand result is invalid');
  const material = ownCompletedFields(fields.material, 'observation_invalid');
  if (
    Object.keys(material).length !== 2 ||
    !Object.hasOwn(material, 'runInput') ||
    !Object.hasOwn(material, 'outputs')
  )
    operationError(
      'observation_invalid',
      'callable demand material is invalid',
    );
  return { runInput: material.runInput, outputs: material.outputs };
}
