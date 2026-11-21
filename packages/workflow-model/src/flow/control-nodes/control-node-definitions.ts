export const CORE_INLINE_DEFINITION_VERSION = 2;

type Definition = Readonly<{ key: string; version: number }>;

function matches(definition: Definition | undefined, key: string): boolean {
  return (
    definition?.key === key &&
    (definition.version === 1 ||
      definition.version === CORE_INLINE_DEFINITION_VERSION)
  );
}

export function isCoreConditionDefinition(
  definition: Definition | undefined,
): boolean {
  return matches(definition, 'core.condition');
}

export function isCoreSwitchDefinition(
  definition: Definition | undefined,
): boolean {
  return matches(definition, 'core.switch');
}

export function isCoreMergeDefinition(
  definition: Definition | undefined,
): boolean {
  return matches(definition, 'core.merge');
}
