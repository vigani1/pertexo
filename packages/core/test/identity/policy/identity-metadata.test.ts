import { describe, expect, it } from 'vitest';
import { parseIdentityMetadata } from '../../src/index.js';

describe('identity audit metadata', () => {
  it('accepts nested ordinary arrays and the exact 8 KiB metadata boundary', () => {
    const exact = { value: 'x'.repeat(8_192 - 12) };
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(8_192);
    expect(parseIdentityMetadata(exact)).toEqual(exact);
    expect(parseIdentityMetadata({ nested: [{ ok: true }, null, 3] })).toEqual({
      nested: [{ ok: true }, null, 3],
    });
  });

  it.each([
    ['over byte limit', { value: 'x'.repeat(8_192 - 11) }],
    [
      'forbidden nested key',
      { nested: [{ authorizationToken: 'must-not-be-admitted' }] },
    ],
    [
      'wide object',
      Object.fromEntries(
        Array.from({ length: 1_025 }, (_, index) => [
          `k${String(index)}`,
          index,
        ]),
      ),
    ],
  ])('rejects %s metadata with a controlled error', (_label, metadata) => {
    expect(() => parseIdentityMetadata(metadata)).toThrow();
  });

  it('rejects cyclic and deeply nested metadata without recursive overflow', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let depth = 0; depth < 4_000; depth += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }

    expect(() => parseIdentityMetadata(cyclic)).toThrow(
      'must not repeat object references',
    );
    expect(() => parseIdentityMetadata(root)).toThrow('depth limit exceeded');
  });
});
