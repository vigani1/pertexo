import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import { WORKFLOW_CALL_FAMILY_POLICY_V1 } from '@pertexo/workflow-model/workflow-call-contract';
import type { CompiledWorkflowExecutableV3 } from '../compilation/executable-v3.js';
import { executableNodes } from '../compilation/executable-graph.js';
import { operationError } from '../operation-values.js';
import { sameOutputReference } from '../output-reference.js';
import type { WorkflowCheckpoint, WorkflowObservation } from '../types.js';
import {
  deriveWorkflowCallControlsV1,
  type WorkflowCallDeclarationMaterialV1,
} from '../workflow-call-control.js';
import { completedOutputReference } from './coordinator-output.js';

export function workflowCallCoordinatorControls(input: {
  readonly executable: CompiledWorkflowExecutableV3;
  readonly checkpoint: WorkflowCheckpoint;
  readonly observations: readonly WorkflowObservation[];
  readonly successfulOutcomes: ReadonlyMap<
    string,
    Readonly<Record<string, JsonValue>>
  >;
  readonly materials?:
    | Readonly<{
        readonly declarations: readonly WorkflowCallDeclarationMaterialV1[];
        readonly facts: readonly unknown[];
        readonly calleeDeclarations: ReadonlyMap<
          string,
          WorkflowCallableDeclarationV1
        >;
      }>
    | undefined;
  readonly controlCanceled: boolean;
  readonly controlDeadline: boolean;
}) {
  if (input.checkpoint.schemaVersion !== 3)
    operationError(
      'workflow_identity_invalid',
      'Call controls require checkpoint V3',
    );
  const callNodes = new Set(
    executableNodes(input.executable.envelope.graph)
      .filter(({ definition }) => definition.key === 'core.workflow_call')
      .map(({ id }) => id),
  );
  const invocationNodes = new Map(
    input.checkpoint.invocations.map(({ invocationKey, nodeId }) => [
      invocationKey,
      nodeId,
    ]),
  );
  const declarations = input.materials?.declarations ?? [];
  if (declarations.length > WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns)
    operationError(
      'observation_invalid',
      'Call material projection exceeds family bound',
    );
  const declarationKeys = new Set<string>();
  for (const material of declarations) {
    if (declarationKeys.has(material.invocationKey))
      operationError(
        'observation_invalid',
        'Call declaration materials are duplicated',
      );
    declarationKeys.add(material.invocationKey);
    const outcomes = [...input.successfulOutcomes.values()].filter(
      (outcome) =>
        outcome.invocationKey === material.invocationKey &&
        outcome.attemptId === material.declarationAttemptId,
    );
    const outcome = outcomes[0];
    const output =
      outcome === undefined
        ? undefined
        : completedOutputReference(outcome, material.declarationAttemptId);
    if (
      outcomes.length !== 1 ||
      output === undefined ||
      !sameOutputReference(output, material.input)
    )
      operationError(
        'observation_invalid',
        'Call declaration has no exact succeeded attempt fact',
      );
  }
  const declarationInvocationKeys = new Set<string>();
  for (const observation of input.observations) {
    if (
      observation.kind !== 'outcome' ||
      observation.status !== 'succeeded' ||
      !callNodes.has(invocationNodes.get(observation.invocationKey) ?? '')
    )
      continue;
    if (!declarationKeys.has(observation.invocationKey))
      operationError(
        'observation_invalid',
        'Call declaration material is missing',
      );
    declarationInvocationKeys.add(observation.invocationKey);
  }
  if (declarationInvocationKeys.size !== declarationKeys.size)
    operationError(
      'observation_invalid',
      'Call declaration material has no source observation',
    );
  const controls = deriveWorkflowCallControlsV1({
    executable: input.executable,
    checkpoint: input.checkpoint,
    declarations,
    facts: input.materials?.facts ?? [],
    calleeDeclarations: input.materials?.calleeDeclarations ?? new Map(),
    cancelRequested: input.controlCanceled,
    deadlineExpired: input.controlDeadline,
  });
  return { controls, declarationInvocationKeys };
}
