import { workflowControlOutputKind } from '@pertexo/workflow-model';

type DefinitionIdentity = Readonly<{ key: string; version: number }>;

export function isCoreParallelDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return workflowControlOutputKind(definition) === 'parallel';
}
