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

export function requiresStructuredCheckpoint(
  definition: DefinitionIdentity,
): boolean {
  return (
    (definition.version === 1 &&
      (definition.key === 'core.condition' ||
        definition.key === 'core.switch')) ||
    isWorkerCoreParallelDefinition(definition)
  );
}
