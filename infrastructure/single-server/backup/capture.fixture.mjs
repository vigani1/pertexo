import { qualifyOwnerLoss } from './owner-loss.fixture.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { docker } from './docker-command.mjs';

/** Exercise the installed capture/prepare programs, with their real transports. */
export async function qualifyCapture({
  directory,
  network,
  source,
  backup,
  database,
  containers,
  takeDump,
  expected,
  databaseContainer,
}) {
  const clone = (
    await readFile('infrastructure/single-server/backup/compose.yaml', 'utf8')
  ).match(/image: (\S+)/u)[1];
  let runner;
  try {
    const nodeImage =
      'node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
    docker(['pull', nodeImage]);
    const environment = {
      ...source,
      DATABASE_MAINTENANCE_URL: database.replace(
        /127\.0\.0\.1:\d+/u,
        'source-db:5432',
      ),
      ...Object.fromEntries(
        [
          'ENDPOINT',
          'REGION',
          'BUCKET',
          'ACCESS_KEY_ID',
          'SECRET_ACCESS_KEY',
        ].map((field) => [
          `BACKUP_STORE_${field}`,
          field === 'ENDPOINT'
            ? 'https://destination.test'
            : backup[`ARTIFACT_STORE_${field}`],
        ]),
      ),
    };
    await writeFile(
      `${directory}/capture.env`,
      Object.entries(environment)
        .map(([key, value]) => `${key}='${value}'\n`)
        .join(''),
      { mode: 0o600 },
    );
    const args = [
      '-e',
      'BACKUP_TRANSPORT_DIRECTORY=/backup',
      '--network',
      network,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-v',
      `${directory}/capture.env:/run/pertexo.env:ro`,
      '-v',
      `${resolve('.')}:/workspace:ro`,
      '-v',
      `${directory}:/backup`,
      '-w',
      '/workspace',
    ];
    runner = spawn(
      'bash',
      [
        'infrastructure/single-server/backup/rclone-requests.sh',
        directory,
        network,
        clone,
      ],
      { stdio: 'inherit' },
    );
    const originalConfig = await readFile(`${directory}/rclone.env`, 'utf8');
    docker([
      'run',
      '--rm',
      ...args,
      nodeImage,
      'node',
      '--env-file=/run/pertexo.env',
      'infrastructure/single-server/backup/prepare.mjs',
      '/backup',
    ]);
    const prepared = (
      await readFile(`${directory}/rclone.env`, 'utf8')
    ).replace(
      'RCLONE_CONFIG_BACKUP_ENDPOINT=https://destination.test',
      'RCLONE_CONFIG_BACKUP_ENDPOINT=http://destination:9000',
    );
    await writeFile(`${directory}/rclone.env`, originalConfig, { mode: 0o600 });
    await writeFile(`${directory}/capture-rclone.env`, prepared, {
      mode: 0o600,
    });
    const id = docker(
      [
        'create',
        '-i',
        ...args,
        '--env-file',
        `${directory}/capture-rclone.env`,
        nodeImage,
        'node',
        '--env-file=/run/pertexo.env',
        'infrastructure/single-server/backup/capture.mjs',
        'capture',
        '/backup',
      ],
      { captureOutput: true },
    ).trim();
    containers.push(id);
    const attached = spawn('docker', ['start', '-ai', id], {
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        await access(`${directory}/capture.ready`);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const running = docker(['inspect', '--format', '{{.State.Status}}', id], {
        captureOutput: true,
      }).trim();
      if (running !== 'running' && running !== 'created')
        throw new Error(
          'Capture failed: ' + docker(['logs', id], { captureOutput: true }),
        );
      if (Date.now() > deadline)
        throw new Error('Capture did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const pausedAt = Date.now();
    const observer = new pg.Client({ connectionString: database });
    await observer.connect();
    try {
      assert.equal(
        (await observer.query('select 1 value')).rows[0].value,
        1,
        'database keeps serving',
      );
      assert.equal(
        (
          await observer.query(
            "select pg_try_advisory_lock_shared(hashtextextended('pertexo.backup.artifact-deletion',0)) acquired",
          )
        ).rows[0].acquired,
        false,
      );
      takeDump();
      await writeFile(`${directory}/dump.done`, 'done');
      const status = docker(['wait', id], { captureOutput: true }).trim();
      attached.stdin.end();
      assert.equal(status, '0', docker(['logs', id], { captureOutput: true }));
      assert.equal(
        (
          await observer.query(
            "select pg_try_advisory_lock_shared(hashtextextended('pertexo.backup.artifact-deletion',0)) acquired",
          )
        ).rows[0].acquired,
        true,
      );
    } finally {
      await observer.end();
    }
    assert.equal(
      JSON.parse(await readFile(`${directory}/objects.json`, 'utf8')).length,
      expected,
      databaseContainer,
    );
    assert.equal(
      (await readFile(`${directory}/objects.count`, 'utf8')).trim(),
      String(expected),
    );
    const pauseMilliseconds = Date.now() - pausedAt;
    await writeFile(`${directory}/KEYCHECK`, 'Pertexo encrypted backups\n');
    docker([
      'run',
      '--rm',
      '--network',
      network,
      '--env-file',
      `${directory}/rclone.env`,
      '-v',
      `${directory}:/backup`,
      clone,
      'copyto',
      '/backup/KEYCHECK',
      'crypt:KEYCHECK',
    ]);
    await qualifyOwnerLoss({
      directory,
      network,
      environment,
      nodeImage,
      rcloneImage: clone,
      database,
      databaseContainer,
    });
    console.log(
      `Installed capture: real prepare/crypt, pre-copy, online pg_dump and deletion lock release passed; zero service stops; paused deletion ${pauseMilliseconds} ms`,
    );
  } finally {
    try {
      docker([
        'rm',
        '-f',
        (await readFile(`${directory}/transport.cid`, 'utf8')).trim(),
      ]);
    } catch {
      // The upstream container may already have removed itself.
    }
    if (runner && runner.exitCode === null && runner.signalCode === null) {
      const closed = once(runner, 'exit');
      runner.kill('SIGTERM');
      await closed;
    }
  }
}
