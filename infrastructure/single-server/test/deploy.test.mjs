import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const oldCommit = 'a'.repeat(40);
const newCommit = 'b'.repeat(40);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-deploy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const state = join(directory, 'state');
  mkdirSync(state);
  writeFileSync(join(directory, '.env.production'), 'FIXTURE=true\n', {
    mode: 0o600,
  });
  writeFileSync(
    join(state, 'hosts.env'),
    'APP_HOST=app.example.test\nFILES_HOST=files.example.test\n',
  );
  writeFileSync(join(state, 'current'), oldCommit + '\n');
  for (const commit of [oldCommit, newCommit]) {
    const release = join(
      directory,
      'releases',
      commit,
      'infrastructure',
      'single-server',
    );
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'compose.yaml'), 'services: {}');
  }
  const log = join(directory, 'commands.jsonl');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env python3
import os, sys, json
args=sys.argv[1:]
with open(os.environ['FIXTURE_LOG'],'a') as log:
 log.write(json.dumps({'args':args,'commit':os.environ.get('SERVICE_VERSION')})+'\\n')
if args[-1]=='/bootstrap.sh' and os.environ.get('FIXTURE_SETUP_FAIL')=='true': sys.exit(1)
if args[0]=='image': print(('amd64' if os.environ.get('FIXTURE_REVISION_BAD')=='true' else 'arm64')+' '+os.environ['SERVICE_VERSION'])
if 'logs' in args: print(os.environ['FIXTURE_MIGRATION_LOG'])
if '--exit-code-from' in args and os.environ.get('FIXTURE_MIGRATION_FAIL')=='true': sys.exit(1)
if '--no-deps' in args and '--wait' in args and os.environ.get('SERVICE_VERSION')=='${newCommit}' and os.environ.get('FIXTURE_UNHEALTHY')=='true': sys.exit(1)
`,
    { mode: 0o755 },
  );
  // These scripts require the Linux host utilities used by Ubuntu deployments.
  if (process.platform !== 'linux') {
    writeFileSync(
      join(bin, 'stat'),
      `#!${process.execPath}\nimport {statSync} from 'node:fs';\nconsole.log((statSync(process.argv.at(-1)).mode & 0o777).toString(8));\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const run = (changes = {}, commit = newCommit) =>
    spawnSync(
      'bash',
      [resolve('infrastructure/single-server/deploy.sh'), commit],
      {
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          PERTEXO_BETA_ROOT: directory,
          FIXTURE_LOG: log,
          FIXTURE_MIGRATION_LOG: 'Database already at migration head.',
          ...changes,
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
  const commands = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { run, commands, state };
}

test('records a healthy release only after migration and serving health', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    newCommit,
  );
  assert.equal(
    readFileSync(join(f.state, 'previous'), 'utf8').trim(),
    oldCommit,
  );
  assert.equal(existsSync(join(f.state, 'migration-fence')), false);
  const commands = f.commands();
  assert.ok(
    commands.findIndex((c) => c.args.includes('--exit-code-from')) <
      commands.findIndex(
        (c) => c.args.includes('--no-deps') && c.args.includes('--wait'),
      ),
  );
});
test('an unhealthy release without migrations returns to the recorded release', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_UNHEALTHY: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /returned to/u);
  assert.ok(
    f
      .commands()
      .some((c) => c.commit === oldCommit && c.args.includes('--wait')),
  );
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    oldCommit,
  );
});
test('a migrated release fixes forward, including a retry now at migration head', (t) => {
  const f = fixture(t);
  assert.equal(
    f.run({
      FIXTURE_UNHEALTHY: 'true',
      FIXTURE_MIGRATION_LOG: 'Applied migrations: 0001_example.sql',
    }).status,
    1,
  );
  assert.ok(existsSync(join(f.state, 'migration-fence')));
  assert.equal(f.run({ FIXTURE_UNHEALTHY: 'true' }).status, 1);
  assert.equal(
    f
      .commands()
      .some((c) => c.commit === oldCommit && c.args.includes('--wait')),
    false,
  );
  assert.ok(existsSync(join(f.state, 'migration-fence')));
});
test('migration failure leaves serving stopped and retains the uncertainty fence', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ FIXTURE_MIGRATION_FAIL: 'true' }).status, 1);
  assert.ok(existsSync(join(f.state, 'migration-fence')));
  assert.equal(
    f
      .commands()
      .some((c) => c.args.includes('--no-deps') && c.args.includes('--wait')),
    false,
  );
});
test('incorrect image architecture fails before serving is stopped', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ FIXTURE_REVISION_BAD: 'true' }).status, 1);
  assert.equal(
    f.commands().some((c) => c.args.includes('stop')),
    false,
  );
});
test('rejects a short or shell-bearing commit before external commands', (t) => {
  const f = fixture(t);
  for (const commit of ['abc123', '$(touch unwanted)'])
    assert.equal(f.run({}, commit).status, 64);
  assert.deepEqual(f.commands(), []);
});
test('refuses an insecure configuration file', (t) => {
  const f = fixture(t);
  const config = join(f.state, '..', '.env.production');
  execFileSync('chmod', ['644', config]);
  assert.equal(f.run().status, 1);
  assert.deepEqual(f.commands(), []);
});

test('storage setup failure resumes the old release only without an unresolved migration fence', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ FIXTURE_SETUP_FAIL: 'true' }).status, 1);
  assert.ok(
    f
      .commands()
      .some((c) => c.commit === oldCommit && c.args.includes('--wait')),
  );
  writeFileSync(join(f.state, 'migration-fence'), newCommit + '\n');
  const before = f.commands().length;
  assert.equal(f.run({ FIXTURE_SETUP_FAIL: 'true' }).status, 1);
  assert.equal(
    f
      .commands()
      .slice(before)
      .some((c) => c.commit === oldCommit && c.args.includes('--wait')),
    false,
  );
});

test('an incomplete restore blocks deployment before image pulls or migrations', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.state, 'restore-fence'), '20261013T030000Z\n');
  assert.equal(f.run().status, 1);
  assert.deepEqual(f.commands(), []);
});
