import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
import { parseDatabaseConfig } from '@pertexo/database/testing';

export const apiUrl = process.env.DATABASE_URL;

export const migrationUrl = testStackSetting('DATABASE_MIGRATION_URL');

export const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

export const redisUrl = testStackSetting('REDIS_URL');

export const emailDomain = 'artifact-transfer.integration.test';

export const requiredArtifactEnvironment = {
  ARTIFACT_STORE_ACCESS_KEY_ID: process.env.ARTIFACT_STORE_ACCESS_KEY_ID,
  ARTIFACT_STORE_BUCKET: process.env.ARTIFACT_STORE_BUCKET,
  ARTIFACT_STORE_ENDPOINT: process.env.ARTIFACT_STORE_ENDPOINT,
  ARTIFACT_STORE_SECRET_ACCESS_KEY:
    process.env.ARTIFACT_STORE_SECRET_ACCESS_KEY,
  ARTIFACT_STORE_REGION: process.env.ARTIFACT_STORE_REGION,
};

export const artifactTransferIntegrationRequested =
  process.env.API_ARTIFACT_INTEGRATION === 'true';

export const artifactTransferIntegrationEnabled =
  artifactTransferIntegrationRequested &&
  apiUrl !== undefined &&
  Object.values(requiredArtifactEnvironment).every(
    (value) => value !== undefined && value.trim() !== '',
  );

export const artifactTransferDatabaseConfig = parseDatabaseConfig({
  connectionString:
    apiUrl ?? 'postgresql://invalid:invalid@unconfigured.invalid:5432/invalid',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 8,
  ownerRole,
});
