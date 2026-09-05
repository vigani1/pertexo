type DefinitionIdentity = Readonly<{ key: string; version: number }>;

function isVersionedCoreDefinition(
  definition: DefinitionIdentity | undefined,
  key: 'core.merge' | 'core.parallel' | 'core.schedule',
): boolean {
  return (
    definition?.key === key &&
    (definition.version === 1 ||
      definition.version === 2 ||
      definition.version === 3)
  );
}

export function isCoreMergeDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return isVersionedCoreDefinition(definition, 'core.merge');
}

export function isCoreParallelDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return isVersionedCoreDefinition(definition, 'core.parallel');
}

function isCoreScheduleDefinition(
  definition: DefinitionIdentity | undefined,
): boolean {
  return isVersionedCoreDefinition(definition, 'core.schedule');
}

export function isTriggerSourceDefinition(
  definition: DefinitionIdentity,
): boolean {
  return (
    (definition.key === 'core.manual' && definition.version === 1) ||
    (definition.key === 'core.webhook' && definition.version === 1) ||
    isCoreScheduleDefinition(definition)
  );
}
