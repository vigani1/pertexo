import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

const commit = 'b'.repeat(40);
const point = '20261013T030000Z';
function fixture(t, restore = false) {
  const root = mkdtempSync(join(tmpdir(), 'pertexo-recovery-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(root, '.env.production'), 'FIXTURE=true\n', {
    mode: 0o600,
  });
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
import os, sys, json, hashlib
from pathlib import Path
args=sys.argv[1:]
root=Path(os.environ['PERTEXO_BETA_ROOT'])
with open(os.environ['FIXTURE_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
fail=os.environ.get('FAIL_AT','')
if fail=='encryption/verify.mjs':
 if 'infrastructure/single-server/encryption/verify.mjs' in args: sys.exit(1)
elif fail and any(fail in arg for arg in args): sys.exit(1)
if args[0]=='version': print('arm64')
if args[0]=='image': print('arm64 ${commit}')
if 'infrastructure/single-server/backup/prepare.mjs' in args:
 (root/'state/source-bucket').write_text('artifacts')
 (root/'state/backup-bucket').write_text('backups')
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
 if 'lsf' in args:
  if os.environ.get('COLLISION'): print('pertexo-beta/${point}/')
  if os.environ.get('OBJECTS_PRESENT'): print('existing-object')
 if 'copyto' in args and args[-1].startswith('/backup/'):
  filename=args[-1].split('/')[-1]
  values={'database.dump':b'database-fixture\\n','release.txt':b'${commit}\\n','objects.count':b'2\\n'}
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
          ...process.env,
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
  commands.some(
    (args) =>
      args.includes('--no-deps') &&
      args.includes('--wait') &&
      args.includes('api') &&
      args.includes('worker') &&
      args.includes('proxy'),
  );
const completed = (commands) =>
  commands.some((args) => args.includes('/backup/COMPLETE'));

test('backup publishes completion last and resumes the previously serving processes', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.ok(resumed(commands));
  const marker = commands.findIndex((args) =>
    args.includes('/backup/COMPLETE'),
  );
  assert.ok(marker > commands.findIndex((args) => args.includes('check')));
  assert.ok(
    commands
      .slice(0, marker)
      .some((args) => args.some((arg) => arg.includes('pg_dump'))),
  );
});
test('capture, upload and byte-check failures resume serving without completing the point', (t) => {
  for (const failure of [
    'pg_dump',
    'copy-objects.mjs',
    '/backup/database.dump',
    'check',
  ]) {
    const f = fixture(t);
    assert.equal(f.run({ FAIL_AT: failure }).status, 1);
    assert.ok(resumed(f.commands()), failure);
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
    { FAIL_AT: '/COMPLETE' },
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
