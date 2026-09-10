import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MUTATIONS,
  validateMutationDefinitions,
} from './verify-mutation-sensitivity.mjs';

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
