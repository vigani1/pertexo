import {
  createCheckpoint,
  createCheckpointV2,
  type CompiledWorkflowExecutableV2,
} from '@pertexo/workflow-engine';

type DefinitionIdentity = Readonly<{ key: string; version: number }>;

export function isWorkerCoreMergeDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return (
    definition?.key === 'core.merge' &&
    (definition.version === 1 ||
      definition.version === 2 ||
      definition.version === 3)
  );
}

export function isWorkerCoreParallelDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return (
    definition?.key === 'core.parallel' &&
    (definition.version === 1 ||
      definition.version === 2 ||
      definition.version === 3)
  );
}

function requiresStructuredCheckpoint(definition: DefinitionIdentity): boolean {
  return (
    (definition.version === 1 &&
      (definition.key === 'core.condition' ||
        definition.key === 'core.switch')) ||
    isWorkerCoreParallelDefinition(definition)
  );
}

export function createWorkerInitialCheckpoint(
  executable: CompiledWorkflowExecutableV2,
  workflowVersionId: string,
) {
  const engineVersion = 'phase3-engine-v1';
  return Object.freeze({
    engineVersion,
    checkpoint: (executable.envelope.graph.nodes.some(({ definition }) =>
      requiresStructuredCheckpoint(definition),
    )
      ? createCheckpointV2
      : createCheckpoint)({
      engineVersion,
      workflowVersionId,
      iterationBudget: 1_000,
      nextEventSequence: 2,
    }),
  });
}
