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
