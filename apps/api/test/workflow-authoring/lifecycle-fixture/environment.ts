import { parseDatabaseConfig } from '@pertexo/database/testing';

import { assertIntegrationGateConfigured } from '../../support/integration-gate.js';

const apiUrl = process.env.DATABASE_URL;

export const migrationUrl = process.env.DATABASE_MIGRATION_URL;

export const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

export const redisUrl = process.env.REDIS_URL;

const workflowLifecycleIntegrationRequested =
  process.env.API_IDENTITY_INTEGRATION === 'true';

assertIntegrationGateConfigured({
  name: 'workflow lifecycle HTTP integration',
  requested: workflowLifecycleIntegrationRequested,
  required: {
    DATABASE_URL: apiUrl,
    DATABASE_MIGRATION_URL: migrationUrl,
    REDIS_URL: redisUrl,
  },
});

export const emailDomain = 'workflow-lifecycle.integration.test';

export const workflowLifecycleIntegrationEnabled =
  workflowLifecycleIntegrationRequested;

export const workflowLifecycleDatabaseConfig = parseDatabaseConfig({
  connectionString:
    apiUrl ?? 'postgresql://invalid:invalid@127.0.0.1:5432/invalid',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 8,
  ownerRole,
});
