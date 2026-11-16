import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faultProject } from './fault-project.mjs';

test('refuses missing and development projects before touching services', () => {
  for (const value of [undefined, '', '  ', 'pertexo']) {
    assert.throws(
      () => faultProject({ COMPOSE_PROJECT_NAME: value }),
      /COMPOSE_PROJECT_NAME/,
    );
  }
  assert.equal(
    faultProject({ COMPOSE_PROJECT_NAME: 'pertexo-ci-123-fault-1' }),
    'pertexo-ci-123-fault-1',
  );
});
