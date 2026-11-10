import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 });
}

test(
  'upstream backup credentials stay out of Docker metadata, argv and logs',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pertexo-j2-privacy-4300-'));
    const secrets = {
      ARTIFACT_STORE_ACCESS_KEY_ID: 'source-key-j2-4300',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'source-secret-j2-4300',
      BACKUP_STORE_ACCESS_KEY_ID: 'destination-key-j2-4300',
      BACKUP_STORE_SECRET_ACCESS_KEY: 'destination-secret-j2-4300',
    };
    let child;
    let closed;
    try {
      execFileSync(
        process.execPath,
        ['infrastructure/single-server/backup/prepare.mjs', directory],
        {
          env: {
            ...process.env,
            ...secrets,
            BACKUP_CRYPT_PASSWORD: '',
            BACKUP_CRYPT_SALT: '',
            ARTIFACT_STORE_ENDPOINT: 'https://source.example.test',
            ARTIFACT_STORE_BUCKET: 'artifacts',
            ARTIFACT_STORE_REGION: 'us-east-1',
            BACKUP_STORE_ENDPOINT: 'https://backup.example.test',
            BACKUP_STORE_BUCKET: 'backups',
            BACKUP_STORE_REGION: 'us-east-1',
          },
          timeout: 10000,
          stdio: 'pipe',
        },
      );
      const image = docker([
        'compose',
        '-f',
        'infrastructure/single-server/backup/compose.yaml',
        'config',
        '--images',
      ]).trim();
      child = spawn(
        'bash',
        [
          'infrastructure/single-server/backup/rclone-requests.sh',
          directory,
          'bridge',
          image,
        ],
        { stdio: 'ignore' },
      );
      closed = once(child, 'close');
      await waitUntilReady(directory, child);
      const cid = (
        await readFile(join(directory, 'transport.cid'), 'utf8')
      ).trim();
      const logs = spawnSync('docker', ['logs', cid], {
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(logs.status, 0, 'container logs are readable');
      const surfaces = {
        inspect: docker(['inspect', cid]),
        argv: docker(['top', cid, '-eo', 'pid,args']),
        logs: logs.stdout + logs.stderr,
      };
      for (const [surface, value] of Object.entries(surfaces)) {
        for (const name of Object.keys(secrets)) {
          assert.ok(
            !value.includes(secrets[name]),
            `${surface} must not expose ${name}`,
          );
        }
      }
    } finally {
      if (child) {
        child.kill('SIGTERM');
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function waitUntilReady(directory, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(
      child.exitCode,
      null,
      'upstream helper remains alive during startup',
    );
    try {
      if ((await readFile(join(directory, 'transport.ready'), 'utf8')).trim())
        return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  assert.fail('upstream helper did not become ready within 15 seconds');
}
