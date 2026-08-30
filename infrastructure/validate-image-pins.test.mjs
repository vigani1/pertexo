import test from 'node:test';
import assert from 'node:assert/strict';

import { validateImagePins } from './validate-image-pins.mjs';

test('requires an immutable digest while retaining the image tag', () => {
  assert.deepEqual(
    validateImagePins('image: postgres:18@sha256:' + 'a'.repeat(64), 'fixture'),
    [],
  );
});

test('rejects mutable tags and digest-only references', () => {
  const errors = validateImagePins(
    ['image: redis:8.2.8-alpine', 'image: redis@sha256:' + 'b'.repeat(64)].join(
      '\n',
    ),
    'fixture',
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0], /must end in a sha256 digest/u);
  assert.match(errors[1], /readable tag/u);
});

test('validates environment image overrides as well as compose images', () => {
  assert.equal(
    validateImagePins(
      'POSTGRES_IMAGE=postgres:18@sha256:' + 'c'.repeat(64),
      'fixture',
    ).length,
    0,
  );
});
