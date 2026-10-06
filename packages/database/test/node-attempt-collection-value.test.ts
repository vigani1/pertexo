import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  projectNativeNodeAttemptCollectionValue,
  projectRetainedNodeAttemptCollectionValue,
} from '../src/execution/node-attempts/node-attempt-collection-value.js';
import { serializeWorkflowExecutionJsonValueV3 } from '../src/execution/stored-execution-value.js';

const items = [{ b: 2, a: 1 }, 'second'];
const selection = {
  loopNodeId: 'loop',
  ordinal: 1,
  collectionSize: 2,
  declaredCollectionChecksum: createHash('sha256')
    .update(serializeWorkflowExecutionJsonValueV3(items))
    .digest('hex'),
};
const output = { items, iterationCount: 2 };

it('projects the same checksum/count/ordinal semantics for retained and native values', () => {
  const expected = { ...selection, collection: items };
  expect(projectRetainedNodeAttemptCollectionValue(selection, output)).toEqual(
    expected,
  );
  expect(projectNativeNodeAttemptCollectionValue(selection, output)).toEqual(
    expected,
  );
});
it.each([
  'checksum',
  'size',
  'negative',
  'outside',
  'count',
  'extra',
  'missing',
  'array',
  'null',
] as const)('rejects invalid %s collection derivation', (kind) => {
  const changed = {
    ...selection,
    ...(kind === 'checksum'
      ? { declaredCollectionChecksum: 'b'.repeat(64) }
      : {}),
    ...(kind === 'size' ? { collectionSize: 1 } : {}),
    ...(kind === 'negative' ? { ordinal: -1 } : {}),
    ...(kind === 'outside' ? { ordinal: 2 } : {}),
  };
  const value =
    kind === 'null'
      ? null
      : kind === 'array'
        ? []
        : kind === 'count'
          ? { ...output, iterationCount: 1 }
          : kind === 'extra'
            ? { ...output, unexpected: true }
            : kind === 'missing'
              ? { items }
              : output;
  expect(() =>
    projectNativeNodeAttemptCollectionValue(changed, value),
  ).toThrow();
  expect(() =>
    projectRetainedNodeAttemptCollectionValue(changed, value),
  ).toThrow();
});
it('uses the existing native byte owner for a large original declaration without widening retained limits', () => {
  const large = ['x'.repeat(300_000)];
  const scope = {
    ...selection,
    ordinal: 0,
    collectionSize: 1,
    declaredCollectionChecksum: createHash('sha256')
      .update(serializeWorkflowExecutionJsonValueV3(large))
      .digest('hex'),
  };
  expect(
    projectNativeNodeAttemptCollectionValue(scope, {
      items: large,
      iterationCount: 1,
    }).collection,
  ).toEqual(large);
  expect(() =>
    projectRetainedNodeAttemptCollectionValue(scope, {
      items: large,
      iterationCount: 1,
    }),
  ).toThrow();
});
