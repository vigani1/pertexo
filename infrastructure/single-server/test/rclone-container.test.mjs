import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { rclone } from '../backup/transport.mjs';

test('the capture transport runs upstream containers and preserves argument boundaries and errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-rclone-container-'));
  const previous = process.env.BACKUP_TRANSPORT_DIRECTORY;
  let runner;
  try {
    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, 'rclone.env'), 'RCLONE_CONFIG=/dev/null\n');
    await writeFile(
      join(directory, 'bin/docker'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'rm') process.exit(0);
fs.writeFileSync(args[args.indexOf('--cidfile') + 1], 'fixture');
if (args.includes('fail')) { process.stderr.write('transport denied'); process.exit(7); }
process.stdout.write(JSON.stringify(args));
`,
      { mode: 0o755 },
    );
    process.env.BACKUP_TRANSPORT_DIRECTORY = directory;
    runner = spawn(
      'bash',
      [
        resolve('infrastructure/single-server/backup/rclone-requests.sh'),
        directory,
        'owned-backup-network',
        'rclone/rclone:pinned',
      ],
      {
        env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}` },
        stdio: 'ignore',
      },
    );
    const args = JSON.parse(
      await rclone(['copyto', '/backup/file with spaces', 'crypt:point/file']),
    );
    assert.deepEqual(args.slice(-3), [
      'copyto',
      '/backup/file with spaces',
      'crypt:point/file',
    ]);
    assert.equal(args[args.indexOf('--network') + 1], 'owned-backup-network');
    assert.equal(
      args[args.indexOf('--env-file') + 1],
      join(directory, 'rclone.env'),
    );
    assert.ok(args.includes('--rm'));
    assert.ok(args.includes('rclone/rclone:pinned'));
    await assert.rejects(
      rclone(['fail']),
      /rclone exited 7: transport denied/u,
    );
  } finally {
    if (runner) {
      const exited = once(runner, 'exit');
      runner.kill('SIGTERM');
      await exited;
    }
    if (previous === undefined) delete process.env.BACKUP_TRANSPORT_DIRECTORY;
    else process.env.BACKUP_TRANSPORT_DIRECTORY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
