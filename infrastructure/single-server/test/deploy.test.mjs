import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { it } from './support/it.mjs';

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
    if (commit === newCommit) {
      mkdirSync(join(release, 'encryption'));
      writeFileSync(join(release, 'encryption/verify.mjs'), 'fixture');
    }
  }
  const log = join(directory, 'commands.jsonl');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The host's architecture, however the script chooses to ask for it.
  writeFileSync(
    join(bin, 'uname'),
    `#!/bin/sh
if [ "$1" = -m ]; then
  case "$FIXTURE_HOST_ARCH" in amd64) echo x86_64 ;; *) echo aarch64 ;; esac
  exit 0
fi
exec ${execFileSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).trim()} "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'dpkg'),
    '#!/bin/sh\necho "${FIXTURE_HOST_ARCH:-arm64}"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env python3
import os, sys, json
args=sys.argv[1:]
with open(os.environ['FIXTURE_LOG'],'a') as log:
 log.write(json.dumps({'args':args,'commit':os.environ.get('SERVICE_VERSION')})+'\\n')
host=os.environ.get('FIXTURE_HOST_ARCH','arm64')
if args[0]=='version' or args[0]=='info' or args[:2]==['system','info']:
 print({'amd64':'x86_64','arm64':'aarch64'}[host] if 'Architecture' in ' '.join(args) else host); sys.exit(0)
if args[-1]=='/bootstrap.sh' and os.environ.get('FIXTURE_SETUP_FAIL')=='true': sys.exit(1)
if args[0]=='image':
 arch='amd64' if os.environ.get('FIXTURE_REVISION_BAD')=='true' else os.environ.get('FIXTURE_IMAGE_ARCH',host)
 revision=os.environ['SERVICE_VERSION']
 template=args[args.index('--format')+1] if '--format' in args else '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
 print(template.replace('{{.Architecture}}',arch).replace('{{.Os}}','linux').replace('{{index .Config.Labels "org.opencontainers.image.revision"}}',revision))
if 'infrastructure/single-server/encryption/verify.mjs' in args and os.environ.get('FIXTURE_ENCRYPTION_FAIL')=='true': sys.exit(1)
if 'infrastructure/single-server/storage/prepare.mjs' in args and 'ghcr.io/vigani1/pertexo:${oldCommit}' in args and os.environ.get('FIXTURE_OLD_CONFIG_REJECTED')=='true': sys.exit(1)
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
  return { run, commands, state, directory };
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
it('accepts ARM images on an ARM server', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_HOST_ARCH: 'arm64' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    newCommit,
  );
});
// ops-05, docs-deps-product-05: common.sh compares the image to the literal arm64.
it.fails('accepts x86 images on an x86 server', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_HOST_ARCH: 'amd64' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    newCommit,
  );
});
// ops-05: an image for another architecture is a broken install, whichever it is.
it.fails('refuses ARM images on an x86 server before stopping serving', (t) => {
  const f = fixture(t);
  const result = f.run({
    FIXTURE_HOST_ARCH: 'amd64',
    FIXTURE_IMAGE_ARCH: 'arm64',
  });
  assert.equal(result.status, 1);
  assert.equal(
    f.commands().some((c) => c.args.includes('stop')),
    false,
  );
});
test('refuses x86 images on an ARM server before stopping serving', (t) => {
  const f = fixture(t);
  const result = f.run({
    FIXTURE_HOST_ARCH: 'arm64',
    FIXTURE_IMAGE_ARCH: 'amd64',
  });
  assert.equal(result.status, 1);
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

test('failed key verification never resumes serving or records the attempted release', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_ENCRYPTION_FAIL: 'true' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Encryption verification failed/u);
  assert.equal(
    f
      .commands()
      .some((c) => c.args.includes('--wait') && c.args.includes('api')),
    false,
  );
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    oldCommit,
  );
  const commands = f.commands();
  assert.ok(
    commands.findIndex((c) => c.args.includes('--exit-code-from')) <
      commands.findIndex((c) =>
        c.args.includes('infrastructure/single-server/encryption/verify.mjs'),
      ),
  );
});
test('older KMS rollback checks with the currently installed compatible verifier', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.state, 'current'), newCommit);
  const result = f.run({}, oldCommit);
  assert.equal(result.status, 0, result.stderr);
  const checks = f
    .commands()
    .filter((c) =>
      c.args.includes('infrastructure/single-server/encryption/verify.mjs'),
    );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].commit, newCommit);
  assert.ok(checks[0].args.includes('--env-from-file'));
  assert.ok(
    f
      .commands()
      .some(
        (c) =>
          c.commit === oldCommit &&
          c.args.includes('--wait') &&
          c.args.includes('api'),
      ),
  );
});
test('older KMS target cannot bypass an incompatible retained key check', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.state, 'current'), newCommit);
  assert.equal(f.run({ FIXTURE_ENCRYPTION_FAIL: 'true' }, oldCommit).status, 1);
  assert.equal(
    f
      .commands()
      .some((c) => c.args.includes('--wait') && c.args.includes('api')),
    false,
  );
});

test('rollback checks the target compiled policy even when its verifier file exists', (t) => {
  for (const failure of [
    { FIXTURE_UNHEALTHY: 'true' },
    { FIXTURE_SETUP_FAIL: 'true' },
  ]) {
    const f = fixture(t);
    const encryption = join(
      f.directory,
      'releases',
      oldCommit,
      'infrastructure/single-server/encryption',
    );
    mkdirSync(encryption);
    writeFileSync(
      join(encryption, 'verify.mjs'),
      'interim verifier, production self-managed still disabled',
    );
    const result = f.run({ ...failure, FIXTURE_OLD_CONFIG_REJECTED: 'true' });
    assert.equal(result.status, 1);
    const commands = f.commands();
    assert.ok(
      commands.some(
        (c) =>
          c.args.includes('infrastructure/single-server/storage/prepare.mjs') &&
          c.args.includes('ghcr.io/vigani1/pertexo:' + oldCommit),
      ),
    );
    assert.equal(
      commands.some(
        (c) =>
          c.commit === oldCommit &&
          c.args.includes('--wait') &&
          c.args.includes('api'),
      ),
      false,
    );
    assert.equal(
      readFileSync(join(f.state, 'current'), 'utf8').trim(),
      oldCommit,
    );
    assert.ok(
      !readdirSync(f.state).some((name) =>
        name.startsWith('.rollback-configuration.'),
      ),
    );
  }
});
test('compatible rollback validates its own configuration before restarting', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_UNHEALTHY: 'true' });
  assert.equal(result.status, 1);
  const commands = f.commands();
  const validation = commands.findIndex(
    (c) =>
      c.args.includes('infrastructure/single-server/storage/prepare.mjs') &&
      c.args.includes('ghcr.io/vigani1/pertexo:' + oldCommit),
  );
  const restart = commands.findIndex(
    (c) =>
      c.commit === oldCommit &&
      c.args.includes('--wait') &&
      c.args.includes('api'),
  );
  assert.ok(validation >= 0 && restart > validation);
  assert.ok(
    !readdirSync(f.state).some((name) =>
      name.startsWith('.rollback-configuration.'),
    ),
  );
});

test('starts the Code service with its release and omits it when returning to a pre-Code release', (t) => {
  const f = fixture(t);
  const app = join(f.directory, 'releases', newCommit, 'apps/code-runner');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  const failed = f.run({ FIXTURE_UNHEALTHY: 'true' });
  assert.equal(failed.status, 1);
  const commands = f.commands();
  assert.ok(
    commands.some(
      (command) =>
        command.commit === newCommit &&
        command.args.includes('stop') &&
        command.args.includes('code-runner'),
    ),
  );
  assert.ok(
    commands.some(
      (command) =>
        command.commit === newCommit &&
        command.args.includes('--wait') &&
        command.args.includes('code-runner'),
    ),
  );
  const restored = commands.filter(
    (command) =>
      command.commit === oldCommit && command.args.includes('--wait'),
  );
  assert.equal(restored.length, 1);
  assert.ok(!restored[0].args.includes('code-runner'));
});
