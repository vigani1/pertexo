import { describe, expect, it } from 'vitest';

import { parseRecoveryConfig } from '../src/config.js';

const environment = {
  ARTIFACT_STORE_ACCESS_KEY_ID: 'artifact-primary-key',
  ARTIFACT_STORE_BUCKET: 'pertexo-artifacts-primary',
  ARTIFACT_STORE_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
  ARTIFACT_STORE_REGION: 'eu-central-1',
  ARTIFACT_STORE_SECRET_ACCESS_KEY: 'artifact-primary-secret',
  ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID: 'artifact-recovery-key',
  ARTIFACT_STORE_RECOVERY_BUCKET: 'pertexo-artifacts-recovery',
  ARTIFACT_STORE_RECOVERY_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
  ARTIFACT_STORE_RECOVERY_REGION: 'eu-west-1',
  ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY: 'artifact-recovery-secret',
  CONTROL_LEDGER_ACCESS_KEY_ID: 'primary-key',
  CONTROL_LEDGER_BUCKET: 'pertexo-control-primary',
  CONTROL_LEDGER_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
  CONTROL_LEDGER_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_REGION: 'eu-central-1',
  CONTROL_LEDGER_SECRET_ACCESS_KEY: 'primary-secret',
  CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: 'recovery-key',
  CONTROL_LEDGER_RECOVERY_BUCKET: 'pertexo-control-recovery',
  CONTROL_LEDGER_RECOVERY_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
  CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS: '30',
  CONTROL_LEDGER_RECOVERY_REGION: 'eu-west-1',
  CONTROL_LEDGER_RECOVERY_SECRET_ACCESS_KEY: 'recovery-secret',
  DATABASE_MAINTENANCE_URL:
    'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
} as const;

describe('parseRecoveryConfig', () => {
  it('applies bounded fail-closed defaults', () => {
    expect(parseRecoveryConfig(environment)).toMatchObject({
      artifacts: {
        primary: { bucket: 'pertexo-artifacts-primary' },
        recovery: { bucket: 'pertexo-artifacts-recovery' },
      },
      coordinator: {
        artifactPageSize: 100,
        externalOperationTimeoutMs: 120_000,
        inventoryPageSize: 100,
        lockTimeoutMs: 10_000,
        maxInventoryPages: 10_000,
        maxArtifactPages: 1_000,
        maxInventorySweeps: 3,
        maxPages: 10,
        maxRecords: 1_000,
        maxWorkspaceReconcileAttempts: 10,
        pageSize: 100,
        statementTimeoutMs: 30_000,
      },
      maintenanceRole: 'pertexo_maintenance',
      observability: {
        environment: 'development',
        logLevel: 'info',
        serviceName: 'pertexo-restore-recovery',
        serviceVersion: '0.0.0-dev',
      },
      timeoutMs: 21_600_000,
    });
  });

  it('rejects incoherent ledger bounds before opening resources', () => {
    expect(() =>
      parseRecoveryConfig({
        ...environment,
        RESTORE_LEDGER_MAX_PAGES: '1',
        RESTORE_LEDGER_MAX_RECORDS: '3',
        RESTORE_LEDGER_PAGE_SIZE: '2',
      }),
    ).toThrow('RESTORE_LEDGER_MAX_RECORDS exceeds page capacity');
  });

  it('rejects shared regional identity', () => {
    expect(() =>
      parseRecoveryConfig({
        ...environment,
        CONTROL_LEDGER_RECOVERY_REGION: 'eu-central-1',
      }),
    ).toThrow('regions must be distinct');
  });

  it('rejects a ledger page size above its record bound', () => {
    expect(() =>
      parseRecoveryConfig({
        ...environment,
        RESTORE_LEDGER_MAX_PAGES: '1',
        RESTORE_LEDGER_MAX_RECORDS: '3',
        RESTORE_LEDGER_PAGE_SIZE: '4',
      }),
    ).toThrow('RESTORE_LEDGER_PAGE_SIZE cannot exceed the record bound');
  });

  it('accepts an exact ledger page capacity', () => {
    expect(
      parseRecoveryConfig({
        ...environment,
        RESTORE_LEDGER_MAX_PAGES: '2',
        RESTORE_LEDGER_MAX_RECORDS: '4',
        RESTORE_LEDGER_PAGE_SIZE: '2',
      }).coordinator,
    ).toMatchObject({ maxPages: 2, maxRecords: 4, pageSize: 2 });
  });

  it.each([
    [
      'primary artifact principal and primary ledger principal',
      {
        ARTIFACT_STORE_ACCESS_KEY_ID: environment.CONTROL_LEDGER_ACCESS_KEY_ID,
      },
    ],
    [
      'primary artifact principal and recovery ledger principal',
      {
        ARTIFACT_STORE_ACCESS_KEY_ID:
          environment.CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID,
      },
    ],
    [
      'recovery artifact principal and primary ledger principal',
      {
        ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID:
          environment.CONTROL_LEDGER_ACCESS_KEY_ID,
      },
    ],
    [
      'recovery artifact principal and recovery ledger principal',
      {
        ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID:
          environment.CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID,
      },
    ],
    [
      'primary artifact bucket and primary ledger bucket',
      { ARTIFACT_STORE_BUCKET: environment.CONTROL_LEDGER_BUCKET },
    ],
    [
      'primary artifact bucket and recovery ledger bucket',
      {
        ARTIFACT_STORE_BUCKET: environment.CONTROL_LEDGER_RECOVERY_BUCKET,
      },
    ],
    [
      'recovery artifact bucket and primary ledger bucket',
      {
        ARTIFACT_STORE_RECOVERY_BUCKET: environment.CONTROL_LEDGER_BUCKET,
      },
    ],
    [
      'recovery artifact bucket and recovery ledger bucket',
      {
        ARTIFACT_STORE_RECOVERY_BUCKET:
          environment.CONTROL_LEDGER_RECOVERY_BUCKET,
      },
    ],
  ] as const)('rejects shared %s', (label, change) => {
    expect(() => parseRecoveryConfig({ ...environment, ...change })).toThrow(
      label.includes('bucket')
        ? 'Control ledger buckets must be distinct from artifact store buckets'
        : 'Tenant artifacts and control ledgers require distinct principals and buckets',
    );
  });

  it('requires telemetry export in production and accepts an explicit endpoint', () => {
    expect(() =>
      parseRecoveryConfig({ ...environment, NODE_ENV: 'production' }),
    ).toThrow('Production recovery job requires OTLP telemetry export');
    expect(
      parseRecoveryConfig({
        ...environment,
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
      }).observability.otlpHttpEndpoint,
    ).toBe('https://otel.example.test');
  });
});
