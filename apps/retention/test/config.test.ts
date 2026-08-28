import { describe, expect, it } from 'vitest';

import { parseRetentionWorkerConfig } from '../src/config.js';

const environment = {
  ARTIFACT_STORE_ACCESS_KEY_ID: 'artifact-key',
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
  ARTIFACT_STORE_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
  ARTIFACT_STORE_REGION: 'eu-central-1',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'artifact-secret',
  ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'artifact-recovery-key',
  ARTIFACT_STORE_RECOVERY_BUCKET: 'pertexo-artifacts-recovery',
  ARTIFACT_STORE_RECOVERY_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
  ARTIFACT_STORE_RECOVERY_REGION: 'eu-west-1',
  ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'artifact-recovery-secret',
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
  DATABASE_MAINTENANCE_URL:
    'postgresql://maintenance:secret@database.internal:5432/pertexo',
  RETENTION_LEASE_OWNER: 'retention-worker-1',
} as const;

describe('retention worker configuration', () => {
  it('uses bounded defaults and only the maintenance database credential', () => {
    expect(parseRetentionWorkerConfig(environment)).toMatchObject({
      artifactStore: {
        primary: { bucket: 'pertexo-artifacts' },
        recovery: { bucket: 'pertexo-artifacts-recovery' },
      },
      database: { max: 2 },
      expectedMaintenanceRole: 'pertexo_maintenance',
      observability: { serviceName: 'pertexo-retention' },
      options: {
        externalOperationTimeoutMs: 30_000,
        leaseOwner: 'retention-worker-1',
        leaseSeconds: 300,
        lockTimeoutMs: 10_000,
        maxPagesPerBatch: 1_000,
        pageSize: 100,
        statementTimeoutMs: 30_000,
      },
      pollIntervalMs: 1_000,
    });
  });

  it('rejects out-of-bound execution controls', () => {
    expect(() =>
      parseRetentionWorkerConfig({
        ...environment,
        RETENTION_PAGE_SIZE: '1001',
      }),
    ).toThrow();
  });

  it('rejects a timeout budget that can outlive the lease', () => {
    expect(() =>
      parseRetentionWorkerConfig({
        ...environment,
        RETENTION_LEASE_SECONDS: '60',
        RETENTION_EXTERNAL_OPERATION_TIMEOUT_MS: '30000',
        RETENTION_DATABASE_STATEMENT_TIMEOUT_MS: '30000',
      }),
    ).toThrow('timeout budget must be shorter than the lease');
  });

  it('rejects reuse of a control-ledger principal for tenant artifacts', () => {
    expect(() =>
      parseRetentionWorkerConfig({
        ...environment,
        ARTIFACT_STORE_ACCESS_KEY_ID: environment.CONTROL_LEDGER_ACCESS_KEY_ID,
      }),
    ).toThrow('distinct principals and buckets');
  });
});
