import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { inspectForEachCollection } from '../src/for-each-collection.js';
import { canonicalJson } from '../src/canonical-json.js';

it('keeps exact empty and canonical collection count/checksum semantics', () => {
  for (const items of [[], [{ z: -0, a: 'value' }], ['x'.repeat(300_000)]]) {
    expect(
      inspectForEachCollection({ items, iterationCount: items.length }),
    ).toEqual({
      collectionSize: items.length,
      collectionChecksum: createHash('sha256')
        .update(canonicalJson(items))
        .digest('hex'),
    });
  }
});

it.each([
  null,
  [],
  { items: [], iterationCount: 0, extra: true },
  { items: [] },
  { items: {}, iterationCount: 0 },
  { items: ['one'], iterationCount: 0 },
  { items: [], iterationCount: 0.5 },
  { items: [], iterationCount: Number.MAX_SAFE_INTEGER + 1 },
  { items: [undefined], iterationCount: 1 },
])(
  'rejects an invalid declaration without scheduling or policy decisions: %j',
  (value) => {
    expect(() => inspectForEachCollection(value)).toThrow(TypeError);
  },
);

it('rejects accessor material without evaluating it', () => {
  let invoked = false;
  const value = { iterationCount: 0 };
  Object.defineProperty(value, 'items', {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  expect(() => inspectForEachCollection(value)).toThrow(TypeError);
  expect(invoked).toBe(false);
});
