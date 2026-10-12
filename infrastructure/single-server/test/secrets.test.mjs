import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { parseApiConfig } from '../../../apps/api/dist/platform/config/api.js';
import { parseWorkerConfig } from '../../../apps/worker/dist/config/worker.js';
import {
  parseMigrationConfig,
  parseOperatorDatabaseConfig,
} from '../../../packages/database/dist/config.js';
import { createApplicationSecretEnvelope } from '../../../packages/integrations/dist/server.js';

function generated() {
  return parseEnv(
    execFileSync(
      process.execPath,
      ['infrastructure/single-server/generate-secrets.mjs'],
      { encoding: 'utf8' },
    ),
  );
}
test('generated keys and URLs work at the actual deployed application boundaries', () => {
  const secrets = generated();
  const environment = {
    ...secrets,
    NODE_ENV: 'production',
    AUTH_MAIL_MODE: 'durable',
    SESSION_COOKIE_SECURE: 'true',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_EMAIL_API_KEY: 'fixture-provider-key',
    INVITATION_EMAIL_API_KEY: 'fixture-provider-key',
    INVITATION_EMAIL_FROM: 'invites@example.test',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo',
    CONNECTION_KMS_REGION: 'eu-central-1',
    TRUST_PROXY_CIDRS: '172.30.42.0/24',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    ARTIFACT_STORE_REGION: 'eu-central-1',
    ARTIFACT_STORE_BUCKET: 'pertexo-artifacts',
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
    WORKER_INSTANCE_ID: 'fixture-worker',
  };
  const api = parseApiConfig(environment);
  const worker = parseWorkerConfig(environment);
  assert.equal(api.observability.otlpHttpEndpoint, undefined);
  assert.equal(worker.observability.otlpHttpEndpoint, undefined);
  assert.equal(
    parseMigrationConfig(environment).connectionString,
    secrets.DATABASE_MIGRATION_URL,
  );
  assert.equal(
    parseOperatorDatabaseConfig(environment).connectionString,
    secrets.DATABASE_MAINTENANCE_URL,
  );
  for (const prefix of ['AUTH_MAIL', 'INVITATION_TOKEN']) {
    const envelope = createApplicationSecretEnvelope({
      current: {
        key: secrets[`${prefix}_KEY`],
        version: secrets[`${prefix}_KEY_VERSION`],
      },
    });
    const context = 'deployment-fixture';
    const sealed = envelope.seal('round trip', context);
    assert.equal(envelope.open(sealed, context).toString(), 'round trip');
  }
  for (const role of ['MIGRATION', 'APP', 'MAINTENANCE']) {
    const variable = role === 'APP' ? 'DATABASE_URL' : `DATABASE_${role}_URL`;
    assert.equal(
      new URL(secrets[variable]).password,
      secrets[`POSTGRES_${role}_PASSWORD`],
    );
  }
  assert.equal(new URL(secrets.REDIS_URL).password, secrets.REDIS_PASSWORD);
  const values = Object.entries(secrets)
    .filter(
      ([key]) =>
        key.endsWith('PASSWORD') ||
        key.endsWith('SECRET') ||
        key.endsWith('_KEY') ||
        key.endsWith('ACCESS_KEY'),
    )
    .map(([, value]) => value);
  assert.equal(new Set(values).size, values.length);
  assert.notEqual(generated().BETTER_AUTH_SECRET, secrets.BETTER_AUTH_SECRET);
});
