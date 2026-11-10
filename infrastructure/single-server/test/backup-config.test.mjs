import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { once } from 'node:events';
import { writeContainerAdapter } from './rclone-container.fixture.mjs';

test('backup tools receive dedicated S3 credentials without KMS or mail secrets', async (t) => {
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
  const dotenv = join(directory, 'crypt.env');
  writeFileSync(
    dotenv,
    "BACKUP_CRYPT_PASSWORD=phrase#comment\nBACKUP_CRYPT_SALT=' salt#\"value '\n",
    { mode: 0o600 },
  );
  const inputEnvironment = { ...environment };
  delete inputEnvironment.BACKUP_CRYPT_PASSWORD;
  delete inputEnvironment.BACKUP_CRYPT_SALT;
  mkdirSync(join(directory, 'bin'));
  await writeContainerAdapter(directory);
  writeFileSync(
    join(directory, 'bin/rclone'),
    `#!${process.execPath}
const fs = require('node:fs');
const observed = ${JSON.stringify(join(directory, 'observed-inputs'))};
const previous = fs.existsSync(observed) ? fs.readFileSync(observed, 'utf8') : '';
fs.appendFileSync(observed, JSON.stringify(fs.readFileSync(0, 'utf8')) + '\\n');
process.stdout.write(previous ? 'fixture-obscured-salt' : 'fixture-obscured-password');
`,
    { mode: 0o755 },
  );
  const runner = spawn(
    'bash',
    [
      'infrastructure/single-server/backup/rclone-requests.sh',
      directory,
      'owned-backup-network',
      'rclone/rclone:pinned',
    ],
    {
      env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}` },
      stdio: 'ignore',
    },
  );
  try {
    const encrypted = spawnSync(
      process.execPath,
      [
        `--env-file=${dotenv}`,
        'infrastructure/single-server/backup/prepare.mjs',
        directory,
      ],
      {
        env: { ...inputEnvironment, BACKUP_TRANSPORT_DIRECTORY: directory },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(encrypted.status, 0, encrypted.stderr);
    assert.deepEqual(
      readFileSync(join(directory, 'observed-inputs'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse),
      ['phrase', ' salt#"value '],
    );
    const prepared = parseEnv(
      readFileSync(join(directory, 'rclone.env'), 'utf8'),
    );
    assert.equal(
      prepared.RCLONE_CONFIG_CRYPT_PASSWORD,
      'fixture-obscured-password',
    );
    assert.equal(
      prepared.RCLONE_CONFIG_CRYPT_PASSWORD2,
      'fixture-obscured-salt',
    );
    for (const file of [
      'transport.input',
      'transport.stdout',
      'transport.stderr',
    ]) {
      assert.equal(existsSync(join(directory, file)), false, file);
    }
  } finally {
    const exited = once(runner, 'exit');
    runner.kill('SIGTERM');
    await exited;
  }
});
