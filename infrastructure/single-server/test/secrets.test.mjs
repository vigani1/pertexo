import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { it } from './support/it.mjs';
import { parseApiConfig } from '../../../apps/api/dist/platform/config/api.js';
import { parseWorkerConfig } from '../../../apps/worker/dist/config/worker.js';
import {
  parseMigrationConfig,
  parseOperatorDatabaseConfig,
} from '../../../packages/database/dist/config.js';
import { createApplicationSecretEnvelope } from '../../../packages/integrations/dist/server.js';

function generated(mode = 'kms') {
  return parseEnv(
    execFileSync(
      process.execPath,
      [
        'infrastructure/single-server/generate-secrets.mjs',
        '--encryption=' + mode,
      ],
      { encoding: 'utf8' },
    ),
  );
}
test('generated keys and URLs work at the actual deployed application boundaries', () => {
  const secrets = generated();
  const environment = {
    ...secrets,
    NODE_ENV: 'production',
    ARTIFACT_SCRATCH_DIRECTORY: '/var/lib/pertexo/artifact-scratch',
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
  assert.equal(api.callbacks.keys.current.key, secrets.CALLBACK_TOKEN_KEY);
  assert.equal(api.callbacks.keys.current.version, '1');
  assert.deepEqual(api.callbacks, worker.callbacks);
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
  for (const prefix of ['AUTH_MAIL', 'INVITATION_TOKEN', 'AUTH_FEDERATION']) {
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

test('self-managed generation works at both production boundaries without AWS configuration', () => {
  const secrets = generated('self-managed');
  const env = {
    ...secrets,
    NODE_ENV: 'production',
    ARTIFACT_SCRATCH_DIRECTORY: '/var/lib/pertexo/artifact-scratch',
    AUTH_MAIL_MODE: 'durable',
    SESSION_COOKIE_SECURE: 'true',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
    INVITATION_EMAIL_API_KEY: 'fixture-mail',
    INVITATION_EMAIL_FROM: 'invites@example.test',
    TRUST_PROXY_CIDRS: '172.30.42.0/24',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    ARTIFACT_STORE_REGION: 'us-east-1',
    ARTIFACT_STORE_BUCKET: 'artifacts',
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
    WORKER_INSTANCE_ID: 'fixture',
  };
  const api = parseApiConfig(env);
  const worker = parseWorkerConfig(env);
  assert.deepEqual(api.connections, worker.connectionEncryption);
  assert.equal(api.connections.mode, 'self-managed');
  assert.equal(
    Buffer.from(secrets.CONNECTION_SELF_MANAGED_KEY, 'base64').length,
    32,
  );
  assert.notEqual(
    generated('self-managed').CONNECTION_SELF_MANAGED_KEY,
    secrets.CONNECTION_SELF_MANAGED_KEY,
  );
  assert.equal(secrets.CONNECTION_KMS_KEY_REFERENCE, undefined);
  assert.equal(secrets.CONNECTION_SELF_MANAGED_KEY_VERSION, '1');
});
// ops-06, docs-deps-product-06: the default asks a self-hoster for an AWS KMS key.
it.fails(
  'with no options, generates what a self-hoster needs and no AWS',
  () => {
    const secrets = parseEnv(
      execFileSync(
        process.execPath,
        ['infrastructure/single-server/generate-secrets.mjs'],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(secrets.CONNECTION_ENCRYPTION_MODE, 'self-managed');
    assert.equal(
      Buffer.from(secrets.CONNECTION_SELF_MANAGED_KEY, 'base64').length,
      32,
    );
    const environment = {
      ...secrets,
      NODE_ENV: 'production',
      ARTIFACT_SCRATCH_DIRECTORY: '/var/lib/pertexo/artifact-scratch',
      AUTH_MAIL_MODE: 'durable',
      SESSION_COOKIE_SECURE: 'true',
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      AUTH_MAIL_FROM: 'security@example.test',
      AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
      INVITATION_EMAIL_API_KEY: 'fixture-mail',
      INVITATION_EMAIL_FROM: 'invites@example.test',
      TRUST_PROXY_CIDRS: '172.30.42.0/24',
      ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
      ARTIFACT_STORE_REGION: 'us-east-1',
      ARTIFACT_STORE_BUCKET: 'artifacts',
      ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
      WORKER_INSTANCE_ID: 'fixture',
    };
    assert.equal(parseApiConfig(environment).connections.mode, 'self-managed');
    assert.equal(
      parseWorkerConfig(environment).connectionEncryption.mode,
      'self-managed',
    );
  },
);
test('KMS stays available for those who choose it', () => {
  assert.equal(generated('kms').CONNECTION_ENCRYPTION_MODE, 'kms');
});
test('generator guidance stays on stderr and invalid selections emit no secrets', () => {
  const script = 'infrastructure/single-server/generate-secrets.mjs';
  const valid = spawnSync(
    process.execPath,
    [script, '--encryption=self-managed'],
    { encoding: 'utf8' },
  );
  assert.equal(valid.status, 0);
  assert.match(valid.stderr, /Never overwrite installed keys/u);
  assert.match(valid.stderr, /password manager/u);
  assert.doesNotMatch(valid.stdout, /password manager/u);
  assert.equal(
    parseEnv(valid.stdout).CONNECTION_ENCRYPTION_MODE,
    'self-managed',
  );
  const invalid = spawnSync(
    process.execPath,
    [script, '--encryption=automatic'],
    { encoding: 'utf8' },
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});

test('preflight refuses an older self-managed target before opening the database', () => {
  const env = generated('self-managed');
  const result = spawnSync(
    process.execPath,
    [
      'infrastructure/single-server/encryption/verify.mjs',
      '/absent-old-release-verifier',
    ],
    { env: { ...env, NODE_ENV: 'production' }, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    JSON.parse(result.stderr).code,
    'configuration_or_database_invalid',
  );
  assert.doesNotMatch(result.stderr, /inventory_unavailable/u);
  assert.ok(!result.stderr.includes(env.CONNECTION_SELF_MANAGED_KEY));
});
