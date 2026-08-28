type IntegrationGateConfiguration = Readonly<{
  name: string;
  requested: boolean;
  required: Readonly<Record<string, string | undefined>>;
}>;

export function assertIntegrationGateConfigured(
  configuration: IntegrationGateConfiguration,
): void {
  if (!configuration.requested) return;

  const missing = Object.entries(configuration.required)
    .filter(([, value]) => value === undefined || value.trim() === '')
    .map(([name]) => name);
  if (missing.length === 0) return;

  throw new Error(
    `Integration gate "${configuration.name}" was requested but is missing required configuration: ${missing.join(', ')}`,
  );
}
