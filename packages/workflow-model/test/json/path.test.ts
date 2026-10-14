import { describe, expect, it } from 'vitest';
import {
  parseJsonPath,
  resolveJsonPath,
  type JsonValue,
} from '../../src/index.js';
describe('preparsed JSON path resolution', () => {
  it.each([
    '$',
    '$.orders[0].id',
    "$['spaced key']",
    '$.missing',
    '$.constructor',
    '$.orders[2]',
  ])('preserves string-path behavior for %s', (path) => {
    const segments = parseJsonPath(path);
    if (segments === undefined) throw new Error('Valid path fixture required');
    const input: JsonValue = { orders: [{ id: 3 }], 'spaced key': null };
    expect(resolveJsonPath(input, segments)).toEqual(
      resolveJsonPath(input, path),
    );
    expect(segments).toEqual(parseJsonPath(path));
  });
  it('keeps invalid string paths explicit and own properties distinct from prototypes', () => {
    expect(resolveJsonPath({}, '$..x')).toMatchObject({
      kind: 'error',
      code: 'invalid_path',
    });
    expect(resolveJsonPath({}, ['constructor'])).toEqual({ kind: 'missing' });
    expect(resolveJsonPath({ constructor: null }, ['constructor'])).toEqual({
      kind: 'value',
      value: null,
    });
  });
});
