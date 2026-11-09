import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  cpSync,
  copyFileSync,
  utimesSync,
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
import { it } from 'node:test';

const oldCommit = 'a'.repeat(40);
const newCommit = 'b'.repeat(40);
const applicationSettings =
  readFileSync('infrastructure/single-server/.env.production.example', 'utf8') +
  '\n' +
  execFileSync(
    process.execPath,
    [
      'infrastructure/single-server/generate-secrets.mjs',
      '--encryption=self-managed',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((line) => !line.startsWith('BACKUP_CRYPT_'))
    .join('\n') +
  '\nPUBLIC_WEB_ORIGIN=https://app.example.test\nARTIFACT_STORE_ENDPOINT=https://files.example.test\nAUTH_MAIL_FROM=auth@example.test\nINVITATION_EMAIL_FROM=invite@example.test\nAUTH_MAIL_EMAIL_API_KEY=fixture-key\nINVITATION_EMAIL_API_KEY=fixture-key\n';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-deploy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const state = join(directory, 'state');
  mkdirSync(state);
  writeFileSync(
    join(directory, '.env.production'),
    applicationSettings +
      'BACKUP_CRYPT_PASSWORD=fixture-password\nBACKUP_CRYPT_SALT=fixture-salt\n',
    {
      mode: 0o600,
    },
  );
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
  const inspection = join(directory, 'inspection');
  mkdirSync(join(inspection, 'infrastructure/single-server'), {
    recursive: true,
  });
  mkdirSync(join(inspection, 'packages/database/dist'), { recursive: true });
  cpSync(
    'packages/database/migrations',
    join(inspection, 'packages/database/migrations'),
    { recursive: true },
  );
  copyFileSync(
    'packages/database/dist/migration-history.js',
    join(inspection, 'packages/database/dist/migration-history.js'),
  );
  copyFileSync(
    'infrastructure/single-server/read-pending-migrations.mjs',
    join(
      inspection,
      'infrastructure/single-server/read-pending-migrations.mjs',
    ),
  );
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
import os, sys, json, time, subprocess
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['FIXTURE_LOG'],'a') as log:
 log.write(json.dumps({'args':args,'commit':os.environ.get('SERVICE_VERSION')})+'\\n')
host=os.environ.get('FIXTURE_HOST_ARCH','arm64')
if args[0]=='version' or args[0]=='info' or args[:2]==['system','info']:
 print({'amd64':'x86_64','arm64':'aarch64'}[host] if 'Architecture' in ' '.join(args) else host); sys.exit(0)
if args[-1]=='/bootstrap.sh' and os.environ.get('FIXTURE_SETUP_FAIL')=='true': sys.exit(1)
if args[0]=='ps' and any(arg.startswith('ancestor=') and arg.endswith(os.environ.get('FIXTURE_IN_USE_SHA','never')) for arg in args): print('fixture-container')
if 'lsf' in args and '--include' in args:
 if os.environ.get('FIXTURE_PRUNE_CATALOG_FAIL')=='true': print('Recovery catalogue unavailable',file=sys.stderr);sys.exit(1)
 if os.environ.get('FIXTURE_RECOVERY_RELEASE'): print('pertexo-beta/20261109T120000Z/release.txt')
if 'cat' in args and any(arg.endswith('/release.txt') for arg in args): print(os.environ.get('FIXTURE_RECOVERY_RELEASE',''))
if args[0]=='image':
 arch='amd64' if os.environ.get('FIXTURE_REVISION_BAD')=='true' else os.environ.get('FIXTURE_IMAGE_ARCH',host)
 revision=os.environ['SERVICE_VERSION']
 template=args[args.index('--format')+1] if '--format' in args else '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
 print(template.replace('{{.Architecture}}',arch).replace('{{.Os}}','linux').replace('{{index .Config.Labels "org.opencontainers.image.revision"}}',revision))
if 'infrastructure/single-server/encryption/verify.mjs' in args and os.environ.get('FIXTURE_ENCRYPTION_FAIL')=='true': sys.exit(1)
if 'infrastructure/single-server/storage/prepare.mjs' in args and 'ghcr.io/vigani1/pertexo:${oldCommit}' in args and os.environ.get('FIXTURE_OLD_CONFIG_REJECTED')=='true': sys.exit(1)
if 'exec' in args and any('--file=-' in arg for arg in args) and os.environ.get('FIXTURE_ROLE_GRANT_FAIL')=='true': sys.exit(1)
if 'infrastructure/single-server/backup/prepare.mjs' in args:
 if os.environ.get('FIXTURE_BACKUP_FAIL')=='true': sys.exit(1)
 prepared=Path(next(args[i+1].split(':/prepared')[0] for i,arg in enumerate(args) if arg=='-v' and args[i+1].endswith(':/prepared')))
 (prepared/'source-bucket').write_text('artifacts')
 (prepared/'backup-bucket').write_text('backups')
 (prepared/'rclone.env').write_text('RCLONE_CONFIG_CRYPT_PASSWORD=fixture')
if 'infrastructure/single-server/backup/capture.mjs' in args and 'capture' in args:
 if os.environ.get('FIXTURE_REQUIRE_DATA_UP')=='true':
  with open(os.environ['FIXTURE_LOG']) as file: commands=[json.loads(line)['args'] for line in file]
  assert any('up' in command and 'postgres' in command and 'redis' in command and 'storage' in command for command in commands), 'database services must start before backup'
 work=Path(next(args[i+1].split(':/backup')[0] for i,arg in enumerate(args) if arg=='-v' and ':/backup' in args[i+1]))
 (work/'capture.ready').write_text('ready')
 deadline=time.monotonic()+2
 while not (work/'dump.done').exists():
  if time.monotonic()>deadline: sys.exit(1)
  time.sleep(.01)
 (work/'objects.count').write_text('0\\n')
 (work/'objects.json').write_text('[]')
if 'exec' in args and any('pg_dump' in arg for arg in args): print('database-fixture')
if 'exec' in args and any('json_agg(' in arg for arg in args):
 rows=json.loads(os.environ.get('FIXTURE_REAL_HISTORY','[]'))
 print(json.dumps([row['name'] for row in rows] if any('json_agg(name' in arg for arg in args) else rows))
if 'infrastructure/single-server/read-pending-migrations.mjs' in args:
 if 'FIXTURE_REAL_HISTORY' in os.environ:
  sys.exit(subprocess.run([os.environ['FIXTURE_NODE'],os.environ['FIXTURE_INSPECTOR']],input=sys.stdin.read(),text=True).returncode)
 print(os.environ.get('FIXTURE_PENDING_MIGRATIONS','0001_example.sql' if os.environ.get('FIXTURE_MIGRATION_LOG','').startswith('Applied') else ''))
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
    writeFileSync(
      join(bin, 'sha256sum'),
      `#!/usr/bin/env python3\nimport sys,hashlib\nfor name in sys.argv[1:]: print(hashlib.sha256(open(name,'rb').read()).hexdigest()+'  '+name)\n`,
      { mode: 0o755 },
    );
  }
  const run = (changes = {}, commit = newCommit, script = 'deploy.sh') =>
    spawnSync(
      'bash',
      [
        resolve('infrastructure/single-server/' + script),
        ...(script === 'deploy.sh' ? [commit] : []),
      ],
      {
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          PERTEXO_BETA_ROOT: directory,
          FIXTURE_LOG: log,
          FIXTURE_NODE: process.execPath,
          FIXTURE_INSPECTOR: join(
            inspection,
            'infrastructure/single-server/read-pending-migrations.mjs',
          ),
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
  return {
    run,
    prune: (changes) => run(changes, newCommit, 'prune.sh'),
    commands,
    state,
    directory,
  };
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
// ops-05, docs-deps-product-05: release-operations.sh compares the image to the literal arm64.
it('accepts x86 images on an x86 server', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_HOST_ARCH: 'amd64' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    newCommit,
  );
});
// ops-05: an image for another architecture is a broken install, whichever it is.
it('refuses ARM images on an x86 server before stopping serving', (t) => {
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

test('role provisioning failure leaves writers stopped before any migration', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_ROLE_GRANT_FAIL: 'true' });
  assert.equal(result.status, 1);
  assert.equal(
    f.commands().some((c) => c.args.includes('--exit-code-from')),
    false,
  );
  assert.equal(
    f
      .commands()
      .some((c) => c.args.includes('--no-deps') && c.args.includes('--wait')),
    false,
  );
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    oldCommit,
  );
});

test('refuses to migrate an existing install when its pre-deploy backup fails', (t) => {
  const f = fixture(t);
  const result = f.run({
    FIXTURE_BACKUP_FAIL: 'true',
    FIXTURE_PENDING_MIGRATIONS: '0001_example.sql',
  });
  assert.notEqual(result.status, 0);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    oldCommit,
  );
  assert.equal(
    f.commands().some((c) => c.args.includes('--exit-code-from')),
    false,
  );
});

test('takes a recovery point before migrating a settled existing install', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_PENDING_MIGRATIONS: '0001_example.sql' });
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  const backup = commands.findIndex((c) =>
    c.args.includes('infrastructure/single-server/backup/prepare.mjs'),
  );
  assert.ok(backup >= 0);
  const complete = commands.findIndex(
    (c) =>
      c.args.includes('copyto') &&
      c.args.some((arg) => arg.endsWith('/COMPLETE')),
  );
  assert.ok(complete >= 0);
  assert.ok(
    complete < commands.findIndex((c) => c.args.includes('--exit-code-from')),
  );
  assert.match(
    readFileSync(join(f.state, 'last-backup'), 'utf8').trim(),
    /^\d{8}T\d{6}Z$/u,
  );
  assert.ok(
    backup < commands.findIndex((c) => c.args.includes('--exit-code-from')),
  );
});

test('does not replace the recovery point while resuming a fenced migration', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.state, 'migration-fence'), newCommit);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    f
      .commands()
      .some((c) =>
        c.args.includes('infrastructure/single-server/backup/prepare.mjs'),
      ),
    false,
  );
});

test('starts stopped data services before taking the required recovery point', (t) => {
  const f = fixture(t);
  const result = f.run({
    FIXTURE_REQUIRE_DATA_UP: 'true',
    FIXTURE_PENDING_MIGRATIONS: '0001_example.sql',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    newCommit,
  );
});

test('redeploys the current commit without optional backup configuration when no migrations are pending', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, '.env.production'), applicationSettings, {
    mode: 0o600,
  });
  const result = f.run({}, oldCommit);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    oldCommit,
  );
  assert.equal(existsSync(join(f.state, 'last-backup')), false);
});

test('redeploys the current commit with a failing backup store when no migrations are pending', (t) => {
  const f = fixture(t);
  const result = f.run({ FIXTURE_BACKUP_FAIL: 'true' }, oldCommit);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    oldCommit,
  );
  assert.equal(existsSync(join(f.state, 'last-backup')), false);
});

test('explains why missing backup configuration blocks pending migrations', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, '.env.production'), applicationSettings, {
    mode: 0o600,
  });
  const result = f.run({ FIXTURE_PENDING_MIGRATIONS: '0001_example.sql' });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Pending migrations require a successful encrypted recovery point/u,
  );
  assert.equal(
    f.commands().some((c) => c.args.includes('--exit-code-from')),
    false,
  );
  assert.equal(
    f.commands().some((c) => c.args.includes('stop')),
    false,
  );
});

test('fresh install migrates without backup configuration or store access', (t) => {
  const f = fixture(t);
  rmSync(join(f.state, 'current'));
  writeFileSync(join(f.directory, '.env.production'), applicationSettings, {
    mode: 0o600,
  });
  const result = f.run({
    FIXTURE_PENDING_MIGRATIONS: '0001_example.sql',
    FIXTURE_BACKUP_FAIL: 'true',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.state, 'current'), 'utf8').trim(),
    newCommit,
  );
  assert.equal(existsSync(join(f.state, 'last-backup')), false);
});

test('retry after failed migration retains the completed recovery point', (t) => {
  const f = fixture(t);
  assert.equal(
    f.run({
      FIXTURE_PENDING_MIGRATIONS: '0001_example.sql',
      FIXTURE_MIGRATION_FAIL: 'true',
    }).status,
    1,
  );
  const point = readFileSync(join(f.state, 'last-backup'), 'utf8');
  const before = f.commands().length;
  const retry = f.run({
    FIXTURE_PENDING_MIGRATIONS: '0001_example.sql',
    FIXTURE_BACKUP_FAIL: 'true',
  });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(readFileSync(join(f.state, 'last-backup'), 'utf8'), point);
  assert.equal(
    f
      .commands()
      .slice(before)
      .some((c) =>
        c.args.includes('infrastructure/single-server/backup/prepare.mjs'),
      ),
    false,
  );
});

test('drains the worker before stopping the Code runner', (t) => {
  const f = fixture(t);
  const app = join(f.directory, 'releases', newCommit, 'apps/code-runner');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const stops = f.commands().filter((c) => c.args.includes('stop'));
  const worker = stops.findIndex((c) => c.args.includes('worker'));
  const runner = stops.findIndex((c) => c.args.includes('code-runner'));
  assert.ok(worker >= 0 && runner > worker);
});

test('reports each missing required setting before pulling release images', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(
      f.directory,
      'releases',
      newCommit,
      'infrastructure/single-server/compose.yaml',
    ),
    'services:\n  api:\n    environment:\n      PUBLIC_WEB_ORIGIN: ${PUBLIC_WEB_ORIGIN:?}\n      AUTH_MAIL_FROM: ${AUTH_MAIL_FROM:?}\n',
  );
  const result = f.run({ PUBLIC_WEB_ORIGIN: '', AUTH_MAIL_FROM: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PUBLIC_WEB_ORIGIN.*\.env.production/u);
  assert.match(result.stderr, /AUTH_MAIL_FROM.*\.env.production/u);
  assert.equal(
    f.commands().some((c) => c.args.includes('pull')),
    false,
  );
});

test('incompatible migration receipts leave writers running, including fenced rollback', (t) => {
  const baseline = JSON.parse(
    readFileSync(
      'packages/database/migrations/pre-baseline-history.json',
      'utf8',
    ),
  )[0];
  for (const rows of [
    [{ name: '9999_future.sql', checksum: 'future' }],
    [baseline],
  ]) {
    for (const fenced of [false, true]) {
      const f = fixture(t);
      if (fenced) writeFileSync(join(f.state, 'migration-fence'), newCommit);
      const result = f.run({ FIXTURE_REAL_HISTORY: JSON.stringify(rows) });
      assert.notEqual(result.status, 0);
      assert.equal(
        f.commands().some((c) => c.args.includes('stop')),
        false,
      );
      assert.equal(
        readFileSync(join(f.state, 'current'), 'utf8').trim(),
        oldCommit,
      );
    }
  }
});

test('conditional app configuration is checked by the real schemas before image pulls', (t) => {
  for (const [values, expected] of [
    [
      'SYSTEM_MAIL_TRANSPORT=smtp\nSYSTEM_MAIL_SMTP_HOST=\n',
      /SYSTEM_MAIL_SMTP_HOST/u,
    ],
    [
      'AUTH_GOOGLE_CLIENT_ID=fixture-client\nAUTH_GOOGLE_CLIENT_SECRET=\n',
      /AUTH_GOOGLE/u,
    ],
    [
      'CONNECTION_ENCRYPTION_MODE=kms\nCONNECTION_KMS_KEY_REFERENCE=\nCONNECTION_KMS_REGION=\n',
      /CONNECTION/u,
    ],
  ]) {
    const f = fixture(t);
    writeFileSync(
      join(f.directory, '.env.production'),
      applicationSettings + values,
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, /\.env.production/u);
    assert.equal(
      f.commands().some((c) => c.args.includes('pull')),
      false,
    );
  }
});

function oldReleases(f) {
  return Array.from({ length: 6 }, (_, i) => {
    const commit = (i + 1).toString(16).padStart(40, '0');
    const path = join(f.directory, 'releases', commit);
    mkdirSync(path);
    utimesSync(path, 100000 + i, 100000 + i);
    return commit;
  });
}

test('successful deploy bounds local releases and protects recovery references and used images', (t) => {
  const f = fixture(t);
  const old = oldReleases(f);
  writeFileSync(
    join(f.directory, '.env.production'),
    applicationSettings +
      'BACKUP_STORE_ENDPOINT=https://backup.example.test\nBACKUP_CRYPT_PASSWORD=fixture-password\nBACKUP_CRYPT_SALT=fixture-salt\n',
  );
  const result = f.run({
    FIXTURE_RECOVERY_RELEASE: old[0],
    FIXTURE_IN_USE_SHA: old[1],
  });
  assert.equal(result.status, 0, result.stderr);
  for (const commit of [oldCommit, newCommit, old[0], old[1], old[5]])
    assert.ok(existsSync(join(f.directory, 'releases', commit)), commit);
  for (const commit of old.slice(2, 5))
    assert.equal(
      existsSync(join(f.directory, 'releases', commit)),
      false,
      commit,
    );
  const removed = f
    .commands()
    .filter((c) => c.args[0] === 'image' && c.args[1] === 'rm')
    .flatMap((c) => c.args);
  assert.equal(
    removed.some((v) => v.endsWith(old[0]) || v.endsWith(old[1])),
    false,
  );
  assert.equal(removed.includes('--force'), false);
});

test('unavailable recovery catalogue leaves every old release available', (t) => {
  const f = fixture(t);
  const old = oldReleases(f);
  writeFileSync(
    join(f.directory, '.env.production'),
    applicationSettings +
      'BACKUP_STORE_ENDPOINT=https://backup.example.test\nBACKUP_CRYPT_PASSWORD=fixture-password\nBACKUP_CRYPT_SALT=fixture-salt\n',
  );
  const result = f.run({ FIXTURE_PRUNE_CATALOG_FAIL: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /cleanup|Cleanup/u);
  for (const commit of old)
    assert.ok(existsSync(join(f.directory, 'releases', commit)));
  assert.equal(
    f.commands().some((c) => c.args[0] === 'image' && c.args[1] === 'rm'),
    false,
  );
});

test('cleanup refuses an unresolved migration or restore before removing releases', (t) => {
  for (const fence of ['migration-fence', 'restore-fence']) {
    const f = fixture(t);
    const old = oldReleases(f);
    writeFileSync(join(f.state, fence), newCommit);
    const result = f.prune();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete/u);
    for (const commit of old)
      assert.ok(existsSync(join(f.directory, 'releases', commit)));
  }
});
