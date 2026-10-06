import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type { parseCheckpoint } from '../checkpoint/checkpoint.js';
import type { WorkflowExecutableNodeV2 } from '../executable-workflow.js';
import type { WorkflowObservation } from '../types.js';
import type { LoadCoordinatorControlDeclaration } from './control-declaration-demand.js';
import { prepareNativeControlObservations } from './native-control-preparation.js';
import { branchSelectionObservations } from './coordinator-observations.js';
import {
  forEachCoordinatorObservations,
  orderForEachObservations,
} from './coordinator-loop-observations.js';
import {
  parseCompletedOutputItems,
  parseCompletedOutputItemsV3,
} from './coordinator-output.js';

/** Internal composition only; native summaries are derived here, never supplied. */
export async function prepareCoordinatorControlObservations(
  input: Readonly<{
    native: boolean;
    completedOutputs: unknown;
    load: LoadCoordinatorControlDeclaration | undefined;
    signal: AbortSignal;
    outcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>;
    checkpoint: ReturnType<typeof parseCheckpoint>;
    invocations: ReadonlyMap<
      string,
      ReturnType<typeof parseCheckpoint>['invocations'][number]
    >;
    nodes: ReadonlyMap<string, WorkflowExecutableNodeV2>;
    persistedFacts: readonly JsonValue[];
    controlCanceled: boolean;
    controlDeadline: boolean;
  }>,
) {
  const completed = input.native
    ? parseCompletedOutputItemsV3(input.completedOutputs)
    : parseCompletedOutputItems(input.completedOutputs);
  const prepared =
    input.load === undefined &&
    !(input.native && (input.controlCanceled || input.controlDeadline))
      ? undefined
      : await prepareNativeControlObservations({
          ...input,
          load: input.load,
        });
  const branchSelections =
    prepared?.branches ??
    branchSelectionObservations(
      completed,
      input.outcomes,
      input.invocations,
      input.nodes,
    );
  return {
    branchSelections,
    forEach(derivedObservations: readonly WorkflowObservation[]) {
      const iterations = forEachCoordinatorObservations(
        completed,
        input.persistedFacts,
        input.outcomes,
        input.checkpoint,
        input.invocations,
        input.nodes,
        derivedObservations,
        prepared?.declarations,
      );
      return prepared === undefined
        ? iterations
        : {
            observations: orderForEachObservations([
              ...prepared.loops,
              ...iterations.observations,
            ]),
            declarationInvocationKeys: prepared.declarations,
          };
    },
  };
}
