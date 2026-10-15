const triggerDefinitions = [
  { key: 'core.manual', version: 1 },
  { key: 'core.webhook', version: 1 },
  { key: 'core.schedule', version: 1 },
  { key: 'core.workflow_error', version: 1 },
  { key: 'core.form', version: 1 },
] as const;

/** Graph checks recognize trigger keys even when their version is unsupported. */
export function isWorkflowTriggerKey(key: string): boolean {
  return triggerDefinitions.some((definition) => definition.key === key);
}

/** Only supported trigger identities receive the accepted run input directly. */
export function isWorkflowTriggerDefinition(
  definition: Readonly<{ key: string; version: number }>,
): boolean {
  return triggerDefinitions.some(
    (trigger) =>
      trigger.key === definition.key && trigger.version === definition.version,
  );
}
