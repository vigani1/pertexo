import { applicationSettings } from './support/application-settings.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const commit = 'b'.repeat(40);
const point = '20261013T030000Z';
function fixture(t, restore = false) {
  const root = mkdtempSync(join(tmpdir(), 'pertexo-recovery-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(
    join(root, '.env.production'),
    applicationSettings +
      'BACKUP_CRYPT_PASSWORD=fixture-password\nBACKUP_CRYPT_SALT=fixture-salt\n',
    {
      mode: 0o600,
    },
  );
  writeFileSync(join(state, 'hosts.env'), 'APP_HOST=app.example.test\n');
  if (!restore) writeFileSync(join(state, 'current'), commit);
  const release = join(
    root,
    'releases',
    commit,
    'infrastructure/single-server',
  );
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'compose.yaml'), 'services: {}');
  mkdirSync(join(release, 'encryption'));
  writeFileSync(join(release, 'encryption/verify.mjs'), 'fixture');
  const log = join(root, 'commands.jsonl');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'date'), `#!/bin/sh\nprintf '${point}\\n'\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env python3
import os, sys, json, hashlib, time, re
from pathlib import Path
args=sys.argv[1:]
root=Path(os.environ['PERTEXO_BETA_ROOT'])
with open(os.environ['FIXTURE_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
if '--cidfile' in args and 'node' in args:
 script=next(arg for arg in args if arg.endswith('.mjs'))
 Path(args[args.index('--cidfile')+1]).write_text('fixture-helper-'+Path(script).stem)
fail=os.environ.get('FAIL_AT','')
if fail=='encryption/verify.mjs':
 if 'infrastructure/single-server/encryption/verify.mjs' in args: sys.exit(1)
elif fail and any(fail in arg for arg in args):
 if 'infrastructure/single-server/backup/prepare.mjs' in args:
  prepared=Path(next(args[i+1].split(':/prepared')[0] for i,arg in enumerate(args) if arg=='-v' and args[i+1].endswith(':/prepared')))
  (prepared/'rclone.env').write_text('RCLONE_CONFIG_CRYPT_PASSWORD=partial-fixture')
  (prepared/'rclone.env').chmod(0o600)
 sys.exit(1)
if os.environ.get('RESTORE') and args[0]=='run' and '--network' in args:
 network=args[args.index('--network')+1]
 if network=='pertexo-beta_private' and not (root/'target-started').exists():
  print('target network does not exist before services start', file=sys.stderr)
  sys.exit(125)
if 'compose' in args and 'up' in args: (root/'target-started').touch()
if '--images' in args:
 manifest=Path(args[args.index('-f')+1]).read_text()
 image=re.search(r'image:\\s*(rclone/rclone:\\S+)',manifest)
 if not image: sys.exit(1)
 print(image.group(1))
if args[0]=='version': print('arm64')
if args[0]=='image': print('arm64 ${commit}')
if 'infrastructure/single-server/backup/prepare.mjs' in args:
 prepared=Path(next(args[i+1].split(':/prepared')[0] for i,arg in enumerate(args) if arg=='-v' and args[i+1].endswith(':/prepared')))
 (prepared/'source-bucket').write_text('artifacts')
 (prepared/'backup-bucket').write_text('backups')
 (prepared/'rclone.env').write_text('RCLONE_CONFIG_CRYPT_PASSWORD=fixture-obscured')
 (prepared/'rclone.env').chmod(0o600)
if 'infrastructure/single-server/backup/capture.mjs' in args and 'capture' in args:
 mounts=[args[i+1] for i,arg in enumerate(args) if arg=='-v']
 work=Path(next(mount.split(':/backup')[0] for mount in mounts if ':/backup' in mount))
 (work/'capture.ready').write_text('ready')
 deadline=time.monotonic()+2
 while not (work/'dump.done').exists():
  if time.monotonic()>deadline: sys.exit(1)
  time.sleep(.01)
 (work/'objects.count').write_text(os.environ.get('COPIED','2')+'\\n')
 (work/'objects.json').write_text('[]')
if 'infrastructure/single-server/backup/key-check.mjs' in args and os.environ.get('KEY_WRONG'):
 print('Provide BACKUP_CRYPT_PASSWORD and BACKUP_CRYPT_SALT',file=sys.stderr)
 sys.exit(1)
if 'infrastructure/single-server/backup/restore-objects.mjs' in args: print('2')
if 'infrastructure/single-server/backup/copy-objects.mjs' in args: print(os.environ.get('COPIED','2'))
if '/recovery-points.mjs' in args and 'validate' in args: print(args[-1])
if 'compose' in args:
 if 'ps' in args: print('postgres' if os.environ.get('RESTORE') else 'api\\nworker\\nproxy')
 if 'exec' in args:
  if any('pg_dump' in arg for arg in args): print('database-fixture')
  elif any('pg_restore' in arg for arg in args): sys.stdin.buffer.read()
  else: print(os.environ.get('RELATIONS','0'))
if any('rclone/rclone:' in arg for arg in args):
 mounts=[args[i+1] for i,arg in enumerate(args) if arg=='-v']
 work=Path(next(mount.split(':/backup')[0] for mount in mounts if ':/backup' in mount))
 if 'cat' in args:
  if args[-1]=='crypt:KEYCHECK':
   if os.environ.get('KEY_WRONG'): sys.exit(1)
   print('Pertexo encrypted backups')
 if 'lsf' in args:
  if '--include' in args and 'COMPLETE' in args and not os.environ.get('MISSING_COMPLETE'):
   if not os.environ.get('ENCRYPTED') or any(arg.startswith('crypt:') for arg in args): print('COMPLETE')
  if os.environ.get('COLLISION'): print('pertexo-beta/${point}/')
  if os.environ.get('OBJECTS_PRESENT'): print('existing-object')
 if 'copyto' in args and args[-1].startswith('/backup/'):
  filename=args[-1].split('/')[-1]
  values={'database.dump':b'database-fixture\\n','release.txt':b'${commit}\\n','objects.count':b'2\\n'}
  if os.environ.get('ENCRYPTED'): values['objects.json']=b'[]'
  if filename=='SHA256SUMS':
   value=''.join(hashlib.sha256(body).hexdigest()+'  '+name+'\\n' for name,body in values.items()).encode()
   if os.environ.get('BAD_CHECKSUM'): value=b'corrupt'
  else: value=values[filename]
  (work/filename).write_bytes(value)
`,
    { mode: 0o755 },
  );
  if (process.platform !== 'linux') {
    writeFileSync(
      join(bin, 'stat'),
      `#!${process.execPath}\nimport {statSync} from 'node:fs'; console.log((statSync(process.argv.at(-1)).mode & 0o777).toString(8));\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'sha256sum'),
      `#!/usr/bin/env python3\nimport sys,hashlib\nfor name in sys.argv[1:]: print(hashlib.sha256(open(name,'rb').read()).hexdigest()+'  '+name)\n`,
      { mode: 0o755 },
    );
  }
  const run = (env = {}) =>
    spawnSync(
      'bash',
      [
        resolve(
          `infrastructure/single-server/${restore ? 'restore' : 'backup'}.sh`,
        ),
        ...(restore ? [point, commit] : []),
      ],
      {
        env: {
          PATH: bin + ':' + process.env.PATH,
          PERTEXO_BETA_ROOT: root,
          FIXTURE_LOG: log,
          ...(restore ? { RESTORE: 'true' } : {}),
          ...env,
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
const resumed = (commands) =>
  commands.some((args) => args.includes('up') && args.includes('api'));
const completed = (commands) =>
  commands.some((args) => args.includes('/backup/COMPLETE'));

test('backup publishes completion last while serving continues without any stop', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.equal(
    commands.some((args) => args.includes('stop')),
    false,
  );
  const marker = commands.findIndex((args) =>
    args.includes('/backup/COMPLETE'),
  );
  assert.ok(marker > commands.findIndex((args) => args.includes('capture')));
  assert.ok(
    commands
      .slice(0, marker)
      .some((args) => args.some((arg) => arg.includes('pg_dump'))),
  );
});
test('capture and upload failures leave serving running without completing the point', (t) => {
  for (const failure of ['pg_dump', 'capture.mjs', '/backup/database.dump']) {
    const f = fixture(t);
    assert.equal(f.run({ FAIL_AT: failure }).status, 1);
    assert.equal(
      f.commands().some((args) => args.includes('stop')),
      false,
      failure,
    );
    assert.equal(completed(f.commands()), false, failure);
  }
});
test('an empty object catalog is complete without an invalid rclone empty-directory check', (t) => {
  const f = fixture(t);
  const result = f.run({ COPIED: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(completed(f.commands()));
  assert.equal(
    f.commands().some((args) => args.includes('check')),
    false,
  );
});
test('colliding recovery points and unresolved migrations fail before stopping serving', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ COLLISION: 'true' }).status, 1);
  assert.equal(
    f.commands().some((args) => args.includes('stop')),
    false,
  );
  writeFileSync(join(f.state, 'migration-fence'), commit);
  const before = f.commands().length;
  assert.equal(f.run().status, 1);
  assert.equal(f.commands().length, before);
});
test('fresh restore completes without migrations or starting serving containers', (t) => {
  const f = fixture(t, true);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.state, 'restore-fence')), false);
  assert.equal(existsSync(join(f.state, 'current')), false);
  assert.equal(
    f
      .commands()
      .some(
        (args) =>
          args.includes('--exit-code-from') ||
          (args.includes('up') && args.includes('api')),
      ),
    false,
  );
});
test('incomplete, corrupt and populated recovery targets are rejected before pg_restore', (t) => {
  for (const env of [
    { MISSING_COMPLETE: 'true' },
    { BAD_CHECKSUM: 'true' },
    { RELATIONS: '1' },
    { OBJECTS_PRESENT: 'true' },
  ]) {
    const f = fixture(t, true);
    assert.equal(f.run(env).status, 1);
    assert.equal(
      f
        .commands()
        .some((args) => args.some((arg) => arg.includes('pg_restore'))),
      false,
    );
  }
});
test('partial restore and missing objects retain the restore fence', (t) => {
  for (const env of [
    { FAIL_AT: 'pg_restore' },
    { FAIL_AT: 'copy-objects.mjs' },
    { COPIED: '1' },
  ]) {
    const f = fixture(t, true);
    assert.equal(f.run(env).status, 1);
    assert.equal(
      readFileSync(join(f.state, 'restore-fence'), 'utf8').trim(),
      point,
    );
  }
});

test('restored keys are verified after data and objects; failure retains the restore fence', (t) => {
  const f = fixture(t, true);
  const result = f.run({ FAIL_AT: 'encryption/verify.mjs' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restore fence remains/u);
  assert.ok(existsSync(join(f.state, 'restore-fence')));
  assert.equal(resumed(f.commands()), false);
  const commands = f.commands();
  const check = commands.findIndex((args) =>
    args.includes('infrastructure/single-server/encryption/verify.mjs'),
  );
  assert.ok(
    check >
      commands.findIndex((args) =>
        args.some((arg) => arg.includes('pg_restore')),
      ),
  );
  assert.ok(check > commands.findIndex((args) => args.includes('restore')));
});

test('encrypted restore refuses missing or wrong keys before starting or writing target services', (t) => {
  for (const settings of [
    { ENCRYPTED: 'true', KEY_WRONG: 'true' },
    { ENCRYPTED: 'true', BACKUP_CRYPT_PASSWORD: '' },
  ]) {
    const f = fixture(t, true);
    const result = f.run(settings);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BACKUP_CRYPT_PASSWORD.*BACKUP_CRYPT_SALT/u);
    assert.equal(
      f
        .commands()
        .some(
          (args) =>
            args.includes('up') ||
            args.some((arg) => arg.includes('pg_restore')),
        ),
      false,
    );
    assert.equal(existsSync(join(f.state, 'restore-fence')), false);
  }
});

test('an encrypted point without COMPLETE refuses before starting target services', (t) => {
  const f = fixture(t, true);
  const result = f.run({ ENCRYPTED: 'true', MISSING_COMPLETE: 'true' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /COMPLETE is missing/u);
  assert.equal(
    f.commands().some((args) => args.includes('up')),
    false,
  );
  assert.equal(existsSync(join(f.state, 'restore-fence')), false);
});

test('a matched encrypted restore validates its manifest and restores objects before clearing the fence', (t) => {
  const f = fixture(t, true);
  const result = f.run({ ENCRYPTED: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.state, 'restore-fence')), false);
  assert.ok(
    f
      .commands()
      .some(
        (args) =>
          args.includes(
            'infrastructure/single-server/backup/restore-objects.mjs',
          ) && args.includes('validate'),
      ),
  );
  assert.ok(
    f
      .commands()
      .some(
        (args) =>
          args.includes(
            'infrastructure/single-server/backup/restore-objects.mjs',
          ) && args.includes('restore'),
      ),
  );
  assert.equal(resumed(f.commands()), false);
});

for (const [name, restore, settings, status] of [
  ['successful backup', false, {}, 0],
  ['failed backup upload', false, { FAIL_AT: '/backup/database.dump' }, 1],
  ['successful encrypted restore', true, { ENCRYPTED: 'true' }, 0],
  ['failed restore checksum', true, { BAD_CHECKSUM: 'true' }, 1],
  ['failed backup preparation', false, { FAIL_AT: 'backup/prepare.mjs' }, 1],
  ['failed restore preparation', true, { FAIL_AT: 'backup/prepare.mjs' }, 1],
]) {
  test(`no rclone config remains after ${name}, including the legacy state copy`, (t) => {
    const f = fixture(t, restore);
    writeFileSync(
      join(f.state, 'rclone.env'),
      'RCLONE_CONFIG_CRYPT_PASSWORD=retired-fixture',
      { mode: 0o600 },
    );
    for (const name of ['.backup.abandoned', '.restore.abandoned']) {
      mkdirSync(join(f.state, name));
      writeFileSync(
        join(f.state, name, 'rclone.env'),
        'RCLONE_CONFIG_CRYPT_PASSWORD=abandoned-fixture',
        { mode: 0o600 },
      );
      for (const file of [
        'transport.input',
        'transport.stdout',
        'transport.stderr',
      ])
        writeFileSync(join(f.state, name, file), 'abandoned-fixture', {
          mode: 0o600,
        });
    }
    const result = f.run(settings);
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(
      readdirSync(f.state, { recursive: true }).filter((name) =>
        name.endsWith('rclone.env'),
      ),
      [],
    );
    assert.deepEqual(
      readdirSync(f.state, { recursive: true }).filter((name) =>
        /transport\.(?:input|stdout|stderr)$/u.test(name),
      ),
      [],
    );
  });
}

test('each backup helper container is removed when its owning invocation finishes', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.equal(
    commands.filter((args) => args.includes('--images')).length,
    1,
    'resolve the upstream pin once per operation',
  );
  const helpers = commands.filter(
    (args) =>
      args[0] === 'run' &&
      args.includes('node') &&
      args.some((arg) =>
        arg.startsWith('infrastructure/single-server/backup/'),
      ),
  );
  assert.ok(helpers.length >= 3);
  for (const args of helpers) {
    assert.ok(args.includes('--cidfile'), 'the host can remove every helper');
    const script = args
      .find((arg) => arg.endsWith('.mjs'))
      .split('/')
      .at(-1)
      .replace('.mjs', '');
    assert.ok(
      commands.some(
        (command) =>
          command[0] === 'rm' && command.includes(`fixture-helper-${script}`),
      ),
      script,
    );
  }
});
