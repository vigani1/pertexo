import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { parseApiConfig } from '../../../apps/api/dist/platform/config/api.js';
import { parseWorkerConfig } from '../../../apps/worker/dist/config/worker.js';

test('both public hosts keep browsers on HTTPS', () => {
  const caddyfile = readFileSync(
    'infrastructure/single-server/Caddyfile',
    'utf8',
  );
  for (const host of ['{$APP_HOST}', '{$FILES_HOST}'])
    assert.match(
      caddyfile.slice(caddyfile.indexOf(`${host} {`)),
      /^\S+ \{\n\timport https_only\n/u,
    );
  assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000"/u);
});

test('resolved Compose gives each role valid deployed configuration and publishes only the proxy', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-compose-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const generated = parseEnv(
    execFileSync(
      process.execPath,
      ['infrastructure/single-server/generate-secrets.mjs'],
      { encoding: 'utf8' },
    ),
  );
  const environment = {
    ...process.env,
    ...parseEnv(
      readFileSync(
        'infrastructure/single-server/.env.production.example',
        'utf8',
      ),
    ),
    ...generated,
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
    INVITATION_EMAIL_FROM: 'invites@example.test',
    INVITATION_EMAIL_API_KEY: 'fixture-mail',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
    AWS_ACCESS_KEY_ID: 'fixture-kms',
    AWS_SECRET_ACCESS_KEY: 'fixture-kms-secret',
    SERVICE_VERSION: 'b'.repeat(40),
    BETA_STATE_DIR: directory,
  };
  execFileSync(
    process.execPath,
    ['infrastructure/single-server/storage/prepare.mjs', directory],
    { env: environment },
  );
  const hosts = parseEnv(readFileSync(join(directory, 'hosts.env'), 'utf8'));
  const config = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        '/dev/null',
        '-f',
        'infrastructure/single-server/compose.yaml',
        'config',
        '--format',
        'json',
      ],
      { env: { ...environment, ...hosts }, encoding: 'utf8' },
    ),
  );
  assert.equal(
    parseApiConfig(config.services.api.environment).nodeEnv,
    'production',
  );
  assert.equal(
    parseWorkerConfig({
      ...config.services.worker.environment,
      WORKER_INSTANCE_ID: 'fixture',
    }).observability.otlpHttpEndpoint,
    undefined,
  );
  assert.equal(
    config.services.worker.environment.AUTH_MAIL_KEY,
    config.services.api.environment.AUTH_MAIL_KEY,
  );
  assert.equal(
    config.services.worker.environment.INVITATION_TOKEN_KEY,
    config.services.api.environment.INVITATION_TOKEN_KEY,
  );
  assert.deepEqual(
    Object.entries(config.services)
      .filter(([, service]) => service.ports?.length)
      .map(([name]) => name),
    ['proxy'],
  );
  assert.equal(
    config.services.storage.environment.AWS_ACCESS_KEY_ID,
    undefined,
  );
  assert.equal(
    config.services.api.environment.STORAGE_ADMIN_SECRET_ACCESS_KEY,
    undefined,
  );
  assert.deepEqual(
    config.services.api.depends_on.migration.condition,
    'service_completed_successfully',
  );
  assert.deepEqual(
    config.services.worker.depends_on.migration.condition,
    'service_completed_successfully',
  );
});
