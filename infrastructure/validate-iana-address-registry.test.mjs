/* global Response */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseApprovedRegistries,
  validateApprovedRegistries,
} from './validate-iana-address-registry.mjs';

test('requires exact unique registry pins', () => {
  assert.throws(() => parseApprovedRegistries(''), /exactly/u);
  const entry =
    "url: 'https://www.iana.org/example.xml', sha256: '" + 'a'.repeat(64) + "'";
  assert.throws(
    () => parseApprovedRegistries(`${entry}\n${entry}`),
    /duplicate/u,
  );
});

test('fails closed when approved upstream bytes drift', async () => {
  await assert.rejects(
    validateApprovedRegistries({
      fetchUpstream: true,
      fetchImplementation: () =>
        Promise.resolve(new Response('changed registry', { status: 200 })),
    }),
    /IANA registry changed/u,
  );
});
