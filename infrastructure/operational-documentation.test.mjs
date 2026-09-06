import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import { validateOperationalReferences } from './operational-documentation.mjs';

async function documents() {
  const [status, inventory, security] = await Promise.all(
    [
      '../docs/current-implementation-status.md',
      '../docs/operations/compatibility-retirement-inventory.md',
      '../docs/operations/release-security-gate.md',
    ].map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  return { status, inventory, security };
}

test('live operational guidance references executable policy and preserves historical evidence', async () => {
  const docs = await documents();
  validateOperationalReferences(docs);
  validateOperationalReferences({
    ...docs,
    status: `${docs.status}\nHistorical head: 0001_old.sql; severity high.\n`,
  });
});

for (const [label, mutate, expected] of [
  [
    'status link drift',
    (docs) => ({
      ...docs,
      status: docs.status.replaceAll(
        'platform/readiness.ts',
        'platform/obsolete.ts',
      ),
    }),
    /current status: missing authoritative reference/u,
  ],
  [
    'stale migration head',
    (docs) => ({
      ...docs,
      status: `Current migration: 0001_old.sql\n${docs.status}`,
    }),
    /not duplicate a migration filename/u,
  ],
  [
    'stale release maximum',
    (docs) => ({
      ...docs,
      inventory: docs.inventory.replace(
        'Epoch 1 / open-ended',
        'Epoch 1 / epoch 24 is current maximum',
      ),
    }),
    /maximum must come from the registry/u,
  ],
  [
    'stale dependency policy',
    (docs) => ({
      ...docs,
      security: docs.security.replace(
        'rejects findings',
        'rejects high findings',
      ),
    }),
    /severity must come from the executable/u,
  ],
]) {
  test(`rejects ${label}`, async () => {
    const docs = await documents();
    assert.throws(() => validateOperationalReferences(mutate(docs)), expected);
  });
}
