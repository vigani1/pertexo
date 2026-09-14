export type ControlLedgerIntegrationProvider = 'aws' | 'minio';

export function assertDedicatedControlLedgerIntegrationFixture(
  environment: Readonly<Record<string, string | undefined>>,
): ControlLedgerIntegrationProvider {
  const provider = environment.CONTROL_LEDGER_INTEGRATION_PROVIDER;
  if (provider !== 'aws' && provider !== 'minio') {
    throw new Error('CONTROL_LEDGER_INTEGRATION_PROVIDER must be aws or minio');
  }
  if (environment.CONTROL_LEDGER_INTEGRATION_DEDICATED_FIXTURE !== 'true') {
    throw new Error(
      'Control-ledger integration requires an explicitly dedicated fixture',
    );
  }
  return provider;
}
