import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  cp,
} from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { eraseArtifact } from '../../../packages/core/dist/lifecycle/artifacts/erase.js';
import { docker } from './docker-command.mjs';

const STARTUP_TIMEOUT_MS = 120_000;

async function until(check, message, milliseconds = 10000) {
  const end = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Docker is adapted to this fixture's network/images; the backup shell and helper are real. */
export async function qualifyOwnerLoss({
  directory,
  network,
  environment,
  nodeImage,
  rcloneImage,
  database,
  databaseContainer,
}) {
  const root = await mkdtemp(join(directory, 'owner-loss-'));
  const commit = 'b'.repeat(40);
  const release = `${root}/releases/${commit}/infrastructure/single-server`;
  await mkdir(`${root}/state`, { recursive: true });
  await mkdir(`${root}/bin`);
  await mkdir(release, { recursive: true });
  await cp(
    resolve('infrastructure/single-server/backup'),
    `${release}/backup`,
    { recursive: true },
  );
  await writeFile(`${release}/compose.yaml`, 'services: {}');
  await writeFile(`${root}/state/current`, commit);
  await writeFile(`${root}/state/hosts.env`, '');
  await writeFile(
    `${root}/.env.production`,
    Object.entries({ ...environment, BACKUP_DUMP_TIMEOUT_SECONDS: '30' })
      .map(([key, value]) => `${key}='${value}'\n`)
      .join(''),
    { mode: 0o600 },
  );
  const realDocker = execFileSync('which', ['docker'], {
    encoding: 'utf8',
  }).trim();
  const adapter = {
    root,
    network,
    nodeImage,
    realDocker,
    databaseContainer,
    workspace: resolve('.'),
  };
  await writeFile(`${root}/adapter.json`, JSON.stringify(adapter));
  await writeFile(
    `${root}/bin/docker`,
    `#!${process.execPath} --
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const c = JSON.parse(fs.readFileSync(process.env.BACKUP_ADAPTER, 'utf8'));
let args = process.argv.slice(2);
if (args[0] === 'ps' && !args.some((arg) => arg.startsWith('label=io.pertexo.backup.'))) process.exit(0);
if (args[0] === 'compose') {
  if (args.includes('--images')) { const r = spawnSync(c.realDocker, args, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
  if (args.includes('ps')) { console.log('api\\nworker\\nproxy'); process.exit(0); }
  if (!args.some((arg) => arg.includes('pg_dump'))) throw new Error('Unexpected compose operation');
  fs.writeFileSync(c.root + '/dump.started', 'started');
  args = ['exec', c.databaseContainer, 'pg_dump', '-U', 'postgres', '-d', 'pertexo', '--format=custom'];
} else if (args[0] === 'run') {
  let image = args.findIndex((arg) => arg.startsWith('ghcr.io/vigani1/pertexo:'));
  if (image >= 0) args.splice(image, 1, '-v', c.workspace + ':/workspace:ro', '-w', '/workspace', c.nodeImage);
  const mount = args.find((arg) => arg.endsWith(':/run/rclone.conf:ro'));
  if (mount) {
    const file = mount.slice(0, -':/run/rclone.conf:ro'.length);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('endpoint = \`https://destination.test\`', 'endpoint = \`http://destination:9000\`'));
  }
  args = args.map((arg) => arg === 'pertexo-beta_private' ? c.network : arg);
}
if (args[0] === 'run' && args.some((arg) => arg.startsWith('rclone/rclone:')) && fs.existsSync(c.root + '/transport-start.fail')) {
  console.error('Fixture denied upstream helper startup'); process.exit(125);
}
const result = spawnSync(c.realDocker, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  await writeFile(`${root}/bin/flock`, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (process.platform !== 'linux') {
    await writeFile(
      `${root}/bin/stat`,
      `#!${process.execPath} --\nconsole.log((require('node:fs').statSync(process.argv.at(-1)).mode & 0o777).toString(8));\n`,
      { mode: 0o755 },
    );
    await writeFile(
      `${root}/bin/sha256sum`,
      `#!${process.execPath} --\nconst fs=require('node:fs'),crypto=require('node:crypto'); for(const file of process.argv.slice(2)) console.log(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+file);\n`,
      { mode: 0o755 },
    );
  }
  await writeFile(
    `${root}/bin/date`,
    `#!${process.execPath} --
const fs = require('node:fs'); const file = ${JSON.stringify(root + '/clock')};
const time = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1000 : Date.now();
fs.writeFileSync(file, String(time)); console.log(new Date(time).toISOString().replace(/[-:]/g, '').replace(/\\.\\d{3}/, ''));
`,
    { mode: 0o755 },
  );
  const pool = new pg.Pool({ connectionString: database, max: 2 });
  const blocker = await pool.connect();
  const log = openSync(`${root}/shell.log`, 'a', 0o600);
  const shells = [];
  const start = () => {
    const child = spawn(
      'bash',
      [resolve('infrastructure/single-server/backup.sh')],
      {
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          PERTEXO_BETA_ROOT: root,
          BACKUP_ADAPTER: `${root}/adapter.json`,
        },
        stdio: ['ignore', log, log],
      },
    );
    const done = once(child, 'exit');
    shells.push({ child, done });
    return { child, done };
  };
  let deleted = false;
  const erase = () =>
    eraseArtifact(
      pool,
      {
        delete: async () => {
          deleted = true;
        },
        head: async () => null,
      },
      { workspaceId: 'fixture', artifactId: 'fixture' },
      { timeoutMs: 2000 },
    );
  const failIfShellExited = async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Backup shell exited during startup (code ${child.exitCode}, signal ${child.signalCode}):\n${await readFile(`${root}/shell.log`, 'utf8')}`,
      );
  };
  const dumpBlocked = async () => {
    const { rows } = await pool.query(
      "select exists (select 1 from pg_stat_activity where application_name='pg_dump' and wait_event_type='Lock') as blocked",
    );
    return rows[0].blocked;
  };
  try {
    // This fixture observes a superuser dump through its maintenance connection.
    const { rows } = await pool.query('select current_user as role');
    docker([
      'exec',
      databaseContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'pertexo',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `grant pg_read_all_stats to "${rows[0].role.replaceAll('"', '""')}" with inherit true`,
    ]);
    await blocker.query('begin');
    await blocker.query('lock table app.artifacts in access exclusive mode');
    const first = start();
    const startupAt = Date.now();
    await until(
      async () => {
        await failIfShellExited(first);
        const blocked = await dumpBlocked();
        await failIfShellExited(first);
        return blocked;
      },
      'Backup did not reach the blocked real pg_dump',
      STARTUP_TIMEOUT_MS,
    );
    console.log(
      `Blocked pg_dump observed after ${Date.now() - startupAt} ms (startup bound ${STARTUP_TIMEOUT_MS} ms)`,
    );
    assert.equal(await erase(), false, 'erasure defers during the dump');
    assert.equal(deleted, false);
    const killedAt = Date.now();
    first.child.kill('SIGKILL');
    const [, signal] = await first.done;
    assert.equal(signal, 'SIGKILL');
    await until(erase, 'Killed backup shell retained the deletion lock', 3000);
    assert.equal(deleted, true, 'deferred erasure resumes');
    assert.deepEqual(
      (await readdir(`${root}/state`, { recursive: true })).filter((name) =>
        /rclone\.(?:env|conf)$/u.test(name),
      ),
      [],
      'EOF removes operation crypt config',
    );
    console.log(
      `SIGKILL backup shell: deletion released and erasure resumed in ${Date.now() - killedAt} ms`,
    );
    await blocker.query('rollback');
    await until(
      async () => !(await dumpBlocked()),
      'Orphan dump did not finish',
    );
    const next = start();
    await until(
      () => next.child.exitCode !== null,
      'New backup did not finish after shell loss',
      60000,
    );
    const [status] = await next.done;
    assert.equal(status, 0, await readFile(`${root}/shell.log`, 'utf8'));
    assert.ok((await readFile(`${root}/state/last-backup`, 'utf8')).trim());
    assert.deepEqual(
      (await readdir(`${root}/state`, { recursive: true })).filter((name) =>
        /rclone\.(?:env|conf)$/u.test(name),
      ),
      [],
      'completed backup removes operation crypt config',
    );
    const published = (
      await readFile(`${root}/state/last-backup`, 'utf8')
    ).trim();
    const payloadFiles = docker(
      [
        'run',
        '--rm',
        '--network',
        network,
        '-v',
        `${directory}/rclone.conf:/run/rclone.conf:ro`,
        '-e',
        'RCLONE_CONFIG=/run/rclone.conf',
        rcloneImage,
        'lsf',
        `crypt:pertexo-beta/${published}`,
        '--files-only',
      ],
      { captureOutput: true },
    )
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(
      payloadFiles,
      [
        'STARTED',
        'COMPLETE',
        'database.dump',
        'release.txt',
        'objects.count',
        'objects.json',
        'SHA256SUMS',
      ].sort(),
      'only the recovery payload is published, never private operation files',
    );
    console.log('A new full backup completed after SIGKILL of the prior shell');
    const settings = await readFile(`${root}/.env.production`, 'utf8');
    await writeFile(
      `${root}/.env.production`,
      settings.replace(
        "BACKUP_DUMP_TIMEOUT_SECONDS='30'",
        "BACKUP_DUMP_TIMEOUT_SECONDS='1'",
      ),
    );
    await blocker.query('begin');
    await blocker.query('lock table app.artifacts in access exclusive mode');
    await rm(`${root}/dump.started`, { force: true });
    const timed = start();
    await until(
      async () => {
        // The persistent launch marker survives a deadline that expires between polls.
        if (existsSync(`${root}/dump.started`)) return true;
        await failIfShellExited(timed);
        return false;
      },
      'Deadline test did not launch pg_dump',
      STARTUP_TIMEOUT_MS,
    );
    await until(
      () => timed.child.exitCode !== null,
      'Dump deadline did not terminate the backup',
      5000,
    );
    const [timedStatus] = await timed.done;
    assert.equal(timedStatus, 1);
    assert.equal(await erase(), true, 'deadline releases the deletion lock');
    assert.match(
      await readFile(`${root}/shell.log`, 'utf8'),
      /BACKUP_DUMP_TIMEOUT_SECONDS exceeded/u,
    );
    console.log(
      'One-second dump deadline failed the backup and released deletion while its shell remained alive',
    );
    await blocker.query('rollback');
    await until(
      async () => !(await dumpBlocked()),
      'Timed-out dump did not finish',
    );
    await writeFile(`${root}/.env.production`, settings);
    const completedPoints = () =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          network,
          '-v',
          `${directory}/rclone.conf:/run/rclone.conf:ro`,
          '-e',
          'RCLONE_CONFIG=/run/rclone.conf',
          rcloneImage,
          'lsf',
          'crypt:pertexo-beta',
          '--recursive',
          '--files-only',
          '--include',
          '**/COMPLETE',
        ],
        { captureOutput: true },
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort();
    const completedBefore = completedPoints();
    const recordedBefore = await readFile(`${root}/state/last-backup`, 'utf8');
    await blocker.query('begin');
    await blocker.query('lock table app.artifacts in access exclusive mode');
    const interrupted = start();
    await until(
      async () => {
        await failIfShellExited(interrupted);
        return dumpBlocked();
      },
      'Transport failure case did not reach the real blocked dump',
      STARTUP_TIMEOUT_MS,
    );
    assert.equal(
      await erase(),
      false,
      'the live backup holds the deletion pause',
    );
    const running = docker(
      ['ps', '-q', '--no-trunc', '--filter', `ancestor=${rcloneImage}`],
      { captureOutput: true },
    )
      .trim()
      .split('\n');
    const transports = [];
    for (const name of await readdir(`${root}/state`)) {
      if (!name.startsWith('.backup.')) continue;
      try {
        const id = (
          await readFile(`${root}/state/${name}/transport.cid`, 'utf8')
        ).trim();
        if (running.includes(id)) transports.push(id);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    assert.equal(
      transports.length,
      1,
      "only this fixture's active transfer is targeted",
    );
    docker(['rm', '-f', transports[0]], { captureOutput: true });
    await until(
      erase,
      'A dead transport retained the backup deletion pause',
      3000,
    );
    await until(
      () => interrupted.child.exitCode !== null,
      'A dead transport did not fail the backup',
    );
    const [interruptedStatus] = await interrupted.done;
    assert.notEqual(interruptedStatus, 0);
    assert.equal(
      await readFile(`${root}/state/last-backup`, 'utf8'),
      recordedBefore,
    );
    assert.deepEqual(
      completedPoints(),
      completedBefore,
      'no partial recovery point is published',
    );
    await blocker.query('rollback');
    await until(
      async () => !(await dumpBlocked()),
      'Interrupted dump did not finish',
    );
    console.log(
      'Killed upstream transport: backup failed, deletion resumed and COMPLETE inventory stayed unchanged',
    );

    await writeFile(`${root}/transport-start.fail`, 'deny');
    const denied = start();
    await until(
      () => denied.child.exitCode !== null,
      'Helper startup failure did not fail the backup',
    );
    const [deniedStatus] = await denied.done;
    assert.notEqual(deniedStatus, 0);
    assert.equal(
      await erase(),
      true,
      'startup failure leaves no deletion pause',
    );
    assert.equal(
      await readFile(`${root}/state/last-backup`, 'utf8'),
      recordedBefore,
    );
    assert.deepEqual(completedPoints(), completedBefore);
    assert.match(
      await readFile(`${root}/shell.log`, 'utf8'),
      /Unable to start upstream rclone helper/u,
    );
    console.log(
      'Denied upstream startup: clear failure, no deletion pause and no published recovery point',
    );
  } catch (error) {
    console.error(await readFile(`${root}/shell.log`, 'utf8'));
    throw error;
  } finally {
    for (const { child } of shells)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    for (const name of await readdir(`${root}/state`))
      if (name.startsWith('.backup.')) {
        try {
          docker(
            [
              'rm',
              '-f',
              (
                await readFile(`${root}/state/${name}/capture.cid`, 'utf8')
              ).trim(),
            ],
            { captureOutput: true },
          );
        } catch {
          /* The normal shell path removes its helper. */
        }
      }
    await blocker.query('rollback');
    blocker.release(true);
    await pool.end();
    closeSync(log);
    await rm(root, { recursive: true, force: true });
  }
}
