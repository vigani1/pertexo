export const GUARDRAILS_STEP = Object.freeze({
  key: 'ai.guardrails',
  version: 1,
});
export const GUARDRAILS_PORTS = Object.freeze(['pass', 'fail'] as const);

export function isGuardrailsDefinition(
  definition: Readonly<{ key: string; version: number }> | undefined,
): boolean {
  return (
    definition?.key === GUARDRAILS_STEP.key &&
    definition.version === GUARDRAILS_STEP.version
  );
}
