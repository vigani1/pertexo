import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorProviderTarget } from './editor-provider-target.mjs';

test('maps a reserved provider host to the owned socket and disables redirects', () => {
  const request = {
    url: 'https://sample.provider.test//elsewhere.test/items?q=1',
    maxRedirects: 3,
    headers: { 'x-api-key': 'fixture-key' },
  };
  assert.deepEqual(editorProviderTarget(request, 4567), {
    ...request,
    url: 'http://127.0.0.1:4567//elsewhere.test/items?q=1',
    maxRedirects: 0,
  });
});

test('leaves other destinations outside the fixture', () => {
  for (const url of [
    'https://provider.test/',
    'https://sample.provider.test:9000/',
    'https://sample.provider.test.other.test/',
    'https://user@sample.provider.test/',
    'http://sample.provider.test/',
    'http://127.0.0.1:4567/',
  ]) {
    assert.equal(
      editorProviderTarget({ url, maxRedirects: 0 }, 4567),
      undefined,
    );
  }
});
