import { describe, expect, it } from 'vitest';

import { parseRecoveryConfig } from '../src/config.js';

const environment = {
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
      coordinator: {
        externalOperationTimeoutMs: 120_000,
        inventoryPageSize: 100,
        lockTimeoutMs: 10_000,
        maxInventoryPages: 10_000,
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
});
