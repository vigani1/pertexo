import { describe, expect, it } from 'vitest';

import { parseLifecycleCommandConfig } from '../src/config.js';

const environment = {
  CONTROL_LEDGER_ACCESS_KEY_ID: 'primary-key',
  CONTROL_LEDGER_BUCKET: 'pertexo-control-primary',
  CONTROL_LEDGER_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
  CONTROL_LEDGER_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: 'recovery-key',
  CONTROL_LEDGER_RECOVERY_BUCKET: 'pertexo-control-recovery',
  CONTROL_LEDGER_RECOVERY_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
  CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_RECOVERY_REGION: 'eu-west-1',
  CONTROL_LEDGER_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
  CONTROL_LEDGER_REGION: 'eu-central-1',
  CONTROL_LEDGER_SECRET_ACCESS_KEY: 'primary-secret',
  DATABASE_LIFECYCLE_COMMAND_URL:
    'postgresql://lifecycle:secret@localhost:5432/pertexo',
  LIFECYCLE_COMMAND_LEASE_OWNER: 'lifecycle:test-1',
} as const;

describe('parseLifecycleCommandConfig', () => {
  it('composes isolated lifecycle database and regional ledger configuration', () => {
    const parsed = parseLifecycleCommandConfig(environment);

    expect(parsed.coordinator).toMatchObject({
      externalOperationTimeoutMs: 30_000,
      leaseDurationMs: 180_000,
      leaseOwner: 'lifecycle:test-1',
    });
    expect(parsed.database.connectionString).toContain('lifecycle:secret');
    expect(parsed.ledger.primary.region).toBe('eu-central-1');
    expect(parsed.ledger.recovery.region).toBe('eu-west-1');
    expect(parsed.observability.serviceName).toBe('pertexo-lifecycle-command');
    expect(parsed.pollIntervalMs).toBe(1_000);
  });

  it('rejects operation timeouts that can outlive the lease', () => {
    expect(() =>
      parseLifecycleCommandConfig({
        ...environment,
        LIFECYCLE_COMMAND_EXTERNAL_OPERATION_TIMEOUT_MS: '2000',
        LIFECYCLE_COMMAND_LEASE_DURATION_MS: '2000',
      }),
    ).toThrow('timeout budget must be shorter than the lease');
  });
});
