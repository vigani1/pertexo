import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { test } from 'node:test';

test('backup tools receive dedicated S3 credentials without KMS or mail secrets', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-backup-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    ARTIFACT_STORE_ACCESS_KEY_ID: 'app-key',
    ARTIFACT_STORE_SECRET_ACCESS_KEY: 'app-secret',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    ARTIFACT_STORE_BUCKET: 'artifacts',
    ARTIFACT_STORE_REGION: 'us-east-1',
    BACKUP_STORE_ACCESS_KEY_ID: 'backup-key',
    BACKUP_STORE_SECRET_ACCESS_KEY: 'backup-secret',
    BACKUP_STORE_ENDPOINT: 'https://s3.backup-provider.example.test',
    BACKUP_STORE_BUCKET: 'backups',
    BACKUP_STORE_REGION: 'eu-central-1',
    AWS_SECRET_ACCESS_KEY: 'must-not-reach-rclone',
  };
  const run = (changes) =>
    spawnSync(
      process.execPath,
      ['infrastructure/single-server/backup/prepare.mjs', directory],
      { env: { ...environment, ...changes }, encoding: 'utf8' },
    );
  assert.equal(run({}).status, 0);
  const values = parseEnv(readFileSync(join(directory, 'rclone.env'), 'utf8'));
  assert.equal(values.RCLONE_CONFIG_SOURCE_ENDPOINT, 'http://storage:9000');
  assert.equal(values.RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY, 'backup-secret');
  assert.equal(values.RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY, 'app-secret');
  assert.equal(values.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(statSync(join(directory, 'rclone.env')).mode & 0o777, 0o600);
  assert.notEqual(
    run({ BACKUP_STORE_ENDPOINT: 'http://remote.example.test' }).status,
    0,
  );
  assert.notEqual(
    run({ BACKUP_STORE_SECRET_ACCESS_KEY: 'secret\nInjected=true' }).status,
    0,
  );
  assert.notEqual(run({ BACKUP_STORE_BUCKET: '../other' }).status, 0);
});
