import { describe, expect, it } from 'vitest';

import { parseRetentionWorkerConfig } from '../src/config.js';

const environment = {
  DATABASE_MAINTENANCE_URL:
    'postgresql://maintenance:secret@database.internal:5432/pertexo',
  RETENTION_LEASE_OWNER: 'retention-worker-1',
} as const;

describe('retention worker configuration', () => {
  it('uses bounded defaults and only the maintenance database credential', () => {
    expect(parseRetentionWorkerConfig(environment)).toMatchObject({
      database: { max: 2 },
      expectedMaintenanceRole: 'pertexo_maintenance',
      observability: { serviceName: 'pertexo-retention' },
      options: {
        leaseOwner: 'retention-worker-1',
        leaseSeconds: 300,
        maxPagesPerBatch: 1_000,
        pageSize: 100,
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
});
