import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  TEST_STACK_SETTINGS,
  requireTestStack,
  testStackSetting,
} from './test-stack.mjs';

const stack = Object.fromEntries(
  TEST_STACK_SETTINGS.map((name) => [name, `set-${name}`]),
);

test('reads a setting that was given', () => {
  assert.equal(testStackSetting('DATABASE_URL', stack), 'set-DATABASE_URL');
});

test('refuses a missing or blank setting and names it', () => {
  for (const value of [undefined, '', '  ']) {
    const environment = { ...stack, DATABASE_URL: value };
    assert.throws(
      () => testStackSetting('DATABASE_URL', environment),
      /Integration tests need DATABASE_URL from a test stack/u,
    );
  }
});

test('names every missing setting a suite needs, and only those', () => {
  assert.throws(
    () => requireTestStack(undefined, { DATABASE_URL: 'set' }),
    /need DATABASE_ADMIN_URL, DATABASE_MIGRATION_URL, DATABASE_MAINTENANCE_URL, REDIS_URL from/u,
  );
  assert.doesNotThrow(() => requireTestStack(['REDIS_URL'], stack));
});

// Twice an integration run without settings fell back to localhost:5432 and
// wrote test databases into the developer's own stack.
test('a real integration suite refuses to start without a test stack', () => {
  const unset = new Set([...TEST_STACK_SETTINGS, 'REDIS_PASSWORD']);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !unset.has(name)),
  );
  const run = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      'test/platform/postgres/abandoned-statement.integration.test.ts',
    ],
    {
      cwd: fileURLToPath(new URL('../../packages/database/', import.meta.url)),
      env: environment,
      encoding: 'utf8',
    },
  );
  assert.notEqual(run.status, 0);
  assert.match(
    `${run.stdout}${run.stderr}`,
    /Integration tests need DATABASE_URL, DATABASE_ADMIN_URL, DATABASE_MIGRATION_URL, DATABASE_MAINTENANCE_URL, REDIS_URL from a test stack/u,
  );
  // Refused in global setup: no test file was collected or run.
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /Test Files .* passed/u);
});
