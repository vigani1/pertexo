export const WORKFLOW_TRIGGER_DEFINITIONS = [
  { key: 'core.manual', version: 1 },
  { key: 'core.webhook', version: 1 },
  { key: 'core.schedule', version: 1 },
  { key: 'core.workflow_error', version: 1 },
  { key: 'core.form', version: 1 },
] as const;

export type WorkflowTriggerDefinition =
  (typeof WORKFLOW_TRIGGER_DEFINITIONS)[number];

/** Graph checks recognize trigger keys even when their version is unsupported. */
export function isWorkflowTriggerKey(key: string): boolean {
  return WORKFLOW_TRIGGER_DEFINITIONS.some(
    (definition) => definition.key === key,
  );
}

/** Only supported trigger identities receive the accepted run input directly. */
export function isWorkflowTriggerDefinition(
  definition: Readonly<{ key: string; version: number }>,
): definition is WorkflowTriggerDefinition {
  return WORKFLOW_TRIGGER_DEFINITIONS.some(
    (trigger) =>
      trigger.key === definition.key && trigger.version === definition.version,
  );
}
