import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

for (const drift of ['migration', 'snapshot']) {
  test(`catalog checker accepts the fresh baseline and refuses ${drift} drift`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pertexo-catalog-check-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'infrastructure/checks'), { recursive: true });
    mkdirSync(join(root, 'packages/database'), { recursive: true });
    for (const path of [
      'infrastructure/checks/database-catalog.mjs',
      'packages/database/dist',
      'packages/database/migrations',
      'packages/database/schema.sql',
    ]) {
      cpSync(path, join(root, path), { recursive: true });
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    symlinkSync(
      resolve('packages/database/node_modules'),
      join(root, 'packages/database/node_modules'),
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [join(root, 'infrastructure/checks/database-catalog.mjs')],
        { encoding: 'utf8' },
      );
    const fresh = run();
    assert.equal(fresh.status, 0, fresh.stderr);
    if (drift === 'migration') {
      writeFileSync(
        join(root, 'packages/database/migrations/0001_catalog_drift.sql'),
        'create table app.catalog_drift(id integer);',
      );
    } else {
      const snapshot = join(root, 'packages/database/schema.sql');
      writeFileSync(
        snapshot,
        readFileSync(snapshot, 'utf8') +
          '\nCREATE TABLE app.snapshot_only(id integer);\n',
      );
    }
    const changed = run();
    assert.notEqual(changed.status, 0, changed.stdout);
    assert.match(changed.stderr, /Database catalog differs/u);
  });
}
