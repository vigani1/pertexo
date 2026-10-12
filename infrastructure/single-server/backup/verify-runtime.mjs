import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';

const image = process.argv[2];
if (!image) throw new Error('usage: verify-runtime.mjs <runtime-image>');
const directory = mkdtempSync(join(tmpdir(), 'pertexo-runtime-helpers-'));
try {
  const prepared = join(directory, 'prepared');
  mkdirSync(prepared);
  const env = {
    ...parseEnv(
      execFileSync(
        process.execPath,
        ['infrastructure/single-server/generate-secrets.mjs'],
        { encoding: 'utf8' },
      ),
    ),
    NODE_ENV: 'production',
    AUTH_MAIL_MODE: 'durable',
    SESSION_COOKIE_SECURE: 'true',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    ARTIFACT_STORE_REGION: 'us-east-1',
    ARTIFACT_STORE_BUCKET: 'artifacts',
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_EMAIL_API_KEY: 'fixture-mail',
    INVITATION_EMAIL_FROM: 'invites@example.test',
    INVITATION_EMAIL_API_KEY: 'fixture-mail',
    CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
    CONNECTION_KMS_REGION: 'eu-central-1',
    TRUST_PROXY_CIDRS: '172.30.42.0/24',
    BACKUP_STORE_ENDPOINT: 'https://backup.example.test',
    BACKUP_STORE_REGION: 'us-east-1',
    BACKUP_STORE_BUCKET: 'backups',
    BACKUP_STORE_ACCESS_KEY_ID: 'fixture-backup',
    BACKUP_STORE_SECRET_ACCESS_KEY: 'fixture-backup-secret',
  };
  const config = join(directory, 'environment');
  writeFileSync(
    config,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    { mode: 0o600 },
  );
  const run = (...args) =>
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--read-only',
        '--network',
        'none',
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '-v',
        `${config}:/run/pertexo.env:ro`,
        '-v',
        `${prepared}:/prepared`,
        '-v',
        `${resolve('infrastructure/single-server')}:/workspace/infrastructure/single-server:ro`,
        image,
        'node',
        '--env-file=/run/pertexo.env',
        ...args,
      ],
      { stdio: 'pipe', timeout: 30000 },
    );
  run('infrastructure/single-server/storage/prepare.mjs', '/prepared');
  run('infrastructure/single-server/backup/prepare.mjs', '/prepared');
  run(
    '--input-type=module',
    '--eval',
    "await import('./infrastructure/single-server/backup/copy-objects.mjs')",
  );
  assert.equal(
    readFileSync(join(prepared, 'source-bucket'), 'utf8'),
    'artifacts',
  );
  assert.equal(
    readFileSync(join(prepared, 'backup-bucket'), 'utf8'),
    'backups',
  );
  console.log('Production-image storage/backup parsers and SDK imports passed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
