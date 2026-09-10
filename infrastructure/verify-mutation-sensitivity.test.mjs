import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MUTATIONS,
  validateMutationDefinitions,
} from './verify-mutation-sensitivity.mjs';
import { preserveTemporaryDirectoryFailure } from './temporary-directory-cleanup.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('every N09 mutation has one exact site and an owning command', async () => {
  assert.equal(validateMutationDefinitions(), MUTATIONS);
  assert.equal(MUTATIONS.length, 7);
  for (const mutation of MUTATIONS) {
    const source = await readFile(path.join(root, mutation.file), 'utf8');
    assert.equal(
      source.split(mutation.search).length - 1,
      1,
      `${mutation.id} must resolve exactly once`,
    );
    assert.notEqual(
      mutation.expectedFailure.source,
      mutation.expectedFailureDetail.source,
      `${mutation.id} must require a failure diagnostic beyond its title`,
    );
  }
});

test('covers provider truth, both control entries, both CLIs, fences, duplicates and evidence compatibility', () => {
  const ids = MUTATIONS.map(({ id }) => id).join(' ');
  for (const expected of [
    'transient-provider',
    'prior-dispatch-control',
    'quality-cli',
    'benchmark-cli',
    'stale-attempt-fence',
    'inbox-duplicate',
    'incompatible-benchmark',
  ])
    assert.match(ids, new RegExp(expected, 'u'));
});

test('preserves primary and temporary-directory cleanup failures', async () => {
  const primary = new Error('validation failed');
  const cleanup = new Error('temporary directory removal failed');

  await assert.rejects(
    preserveTemporaryDirectoryFailure({ error: primary, failed: true }, () =>
      Promise.reject(cleanup),
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    },
  );
});

test('normalizes a sole non-Error temporary-directory cleanup failure', async () => {
  await assert.rejects(
    preserveTemporaryDirectoryFailure({ error: undefined, failed: false }, () =>
      Promise.reject('cleanup rejected'),
    ),
    (error) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'Temporary-directory cleanup failed');
      assert.equal(error.cause, 'cleanup rejected');
      return true;
    },
  );
});
