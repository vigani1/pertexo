import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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

for (const { mode, transport } of ['kms', 'self-managed'].flatMap((mode) =>
  ['resend', 'smtp'].map((transport) => ({ mode, transport })),
))
  test(`resolved Compose isolates credentials for ${mode} and ${transport}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'pertexo-compose-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const generated = parseEnv(
      execFileSync(
        process.execPath,
        [
          'infrastructure/single-server/generate-secrets.mjs',
          '--encryption=' + mode,
        ],
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
      SYSTEM_MAIL_TRANSPORT: transport,
      ...(transport === 'smtp'
        ? {
            SYSTEM_MAIL_SMTP_HOST: 'smtp.example.test',
            SYSTEM_MAIL_SMTP_TLS: 'starttls',
            SYSTEM_MAIL_SMTP_USER: 'fixture-smtp-user',
            SYSTEM_MAIL_SMTP_PASSWORD: 'fixture-smtp-password',
          }
        : {
            AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
            INVITATION_EMAIL_API_KEY: 'fixture-mail',
          }),
      INVITATION_EMAIL_FROM: 'invites@example.test',
      ...(mode === 'kms'
        ? {
            CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
            CONNECTION_KMS_REGION: 'eu-central-1',
            AWS_ACCESS_KEY_ID: 'fixture-kms',
            AWS_SECRET_ACCESS_KEY: 'fixture-kms-secret',
          }
        : {
            CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify([
              { version: '0', key: Buffer.alloc(32, 7).toString('base64') },
            ]),
          }),
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
          '--profile',
          'ops',
          'config',
          '--format',
          'json',
        ],
        { env: { ...environment, ...hosts }, encoding: 'utf8' },
      ),
    );
    const api = parseApiConfig(config.services.api.environment);
    const worker = parseWorkerConfig({
      ...config.services.worker.environment,
      WORKER_INSTANCE_ID: 'fixture',
    });
    assert.equal(worker.authenticationMailDelivery.delivery.mode, transport);
    assert.equal(worker.invitationDelivery.delivery.mode, transport);
    for (const name of ['api', 'ops', 'migration']) {
      assert.equal(
        config.services[name].environment.SYSTEM_MAIL_SMTP_PASSWORD,
        undefined,
      );
      assert.equal(
        config.services[name].environment.AUTH_MAIL_EMAIL_API_KEY,
        undefined,
      );
    }
    if (transport === 'smtp') {
      assert.equal(
        config.services.worker.environment.AUTH_MAIL_EMAIL_API_KEY,
        undefined,
      );
      assert.equal(
        config.services.worker.environment.INVITATION_EMAIL_API_KEY,
        undefined,
      );
      assert.equal(
        worker.authenticationMailDelivery.delivery.auth.pass,
        'fixture-smtp-password',
      );
    }
    if (mode === 'self-managed')
      assert.deepEqual(api.connections, worker.connectionEncryption);
    else {
      assert.equal(
        api.connections.kmsKeyReference,
        worker.connectionEncryption.keyReference,
      );
      assert.equal(api.connections.region, worker.connectionEncryption.region);
    }
    assert.equal(
      config.services.api.environment.DATABASE_MAINTENANCE_URL,
      undefined,
    );
    assert.equal(config.services.api.depends_on.worker, undefined);
    const verification = parseEnv(
      readFileSync(join(directory, 'encryption.env'), 'utf8'),
    );
    assert.equal(
      verification.DATABASE_MAINTENANCE_URL,
      generated.DATABASE_MAINTENANCE_URL,
    );
    assert.ok(
      Object.keys(verification).every(
        (key) =>
          key.startsWith('CONNECTION_') ||
          key.startsWith('AWS_') ||
          ['NODE_ENV', 'DATABASE_MAINTENANCE_URL'].includes(key),
      ),
    );
    for (const file of ['encryption.env', 'api.env', 'worker.env'])
      assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
    if (mode === 'self-managed') {
      assert.equal(
        config.services.api.environment.AWS_ACCESS_KEY_ID,
        undefined,
      );
      assert.equal(verification.CONNECTION_KMS_KEY_REFERENCE, undefined);
      for (const service of ['storage', 'migration', 'ops'])
        assert.equal(
          config.services[service].environment.CONNECTION_SELF_MANAGED_KEY,
          undefined,
        );
      const old = join(directory, 'absent-verifier');
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              'infrastructure/single-server/storage/prepare.mjs',
              directory,
              old,
            ],
            { env: environment, stdio: 'pipe' },
          ),
        /Self-managed encryption requires a release/u,
      );
    }
    assert.equal(api.nodeEnv, 'production');
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
