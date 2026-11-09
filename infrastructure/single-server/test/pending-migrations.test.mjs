import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function image(t) {
  const root = mkdtempSync(join(tmpdir(), 'pertexo-migration-image-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(
    root,
    'infrastructure/single-server/read-pending-migrations.mjs',
  );
  mkdirSync(join(root, 'infrastructure/single-server'), { recursive: true });
  const migrations = join(root, 'packages/database/migrations');
  mkdirSync(migrations, { recursive: true });
  copyFileSync(
    resolve('infrastructure/single-server/read-pending-migrations.mjs'),
    script,
  );
  mkdirSync(join(root, 'packages/database/dist'), { recursive: true });
  copyFileSync(
    resolve('packages/database/dist/migration-history.js'),
    join(root, 'packages/database/dist/migration-history.js'),
  );
  writeFileSync(
    join(migrations, 'pre-baseline-history.json'),
    JSON.stringify([
      { name: '0000_baseline.sql', checksum: 'old' },
      { name: '0122_retired.sql', checksum: 'old' },
    ]),
  );
  for (const name of [
    '0000_baseline.sql',
    '0002_second.sql',
    '0001_first.sql',
    'README.md',
  ])
    writeFileSync(join(migrations, name), '');
  return (history) =>
    spawnSync(process.execPath, [script], { input: history, encoding: 'utf8' });
}

test('reads the selected image inventory and returns only unrecorded SQL files in order', (t) => {
  const run = image(t);
  const result = run(receipts(['0000_baseline.sql']));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '0001_first.sql\n0002_second.sql\n');
});

test('returns no pending migrations for fully recorded image history', (t) => {
  const result = image(t)(
    receipts(['0000_baseline.sql', '0001_first.sql', '0002_second.sql']),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('rejects invalid history without printing its contents', (t) => {
  const run = image(t);
  for (const input of ['private-invalid-input', '{}']) {
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pending migration inspection failed/u);
    assert.equal(result.stderr.includes(input), false);
  }
});

test('backs up before adopting a recorded history containing retired migration names', (t) => {
  const result = image(t)(
    receipts(['0000_baseline.sql', '0122_retired.sql'], 'old'),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    '0000_baseline.sql\n0001_first.sql\n0002_second.sql\n',
  );
});

function receipts(
  names,
  checksum = createHash('sha256').update('').digest('hex'),
) {
  return JSON.stringify(names.map((name) => ({ name, checksum })));
}

test('refuses newer and modified receipts, partial baseline history, and adoption rollback', (t) => {
  const run = image(t);
  for (const input of [
    receipts(['9999_future.sql']),
    receipts(['0000_baseline.sql'], 'modified'),
    receipts(['0000_baseline.sql'], 'old'),
    receipts(['0122_retired.sql'], 'old'),
  ]) {
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /Unknown applied migration|checksum changed|Partial pre-baseline/u,
    );
  }
});
