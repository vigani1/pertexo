import { workflowControlOutputKind } from '@pertexo/workflow-model';

type DefinitionIdentity = Readonly<{ key: string; version: number }>;

export function isCoreMergeDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return definition?.key === 'core.merge' && definition.version === 1;
}

export function isCoreParallelDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return workflowControlOutputKind(definition) === 'parallel';
}

export function isTriggerSourceDefinition(
  definition: DefinitionIdentity,
): boolean {
  return (
    (definition.key === 'core.manual' && definition.version === 1) ||
    (definition.key === 'core.webhook' && definition.version === 1) ||
    (definition.key === 'core.schedule' && definition.version === 1)
  );
}
