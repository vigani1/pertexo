import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  opaqueCursor,
  encodeOpaqueCursor,
  decodeOpaqueCursor,
} from '../../../../src/platform/http/opaque-cursor.js';

it('keeps the existing kind-first opaque cursor format and strict boundary', () => {
  const schema = opaqueCursor('example', { id: z.string().min(1) });
  const known = 'eyJraW5kIjoiZXhhbXBsZSIsImlkIjoib25lIn0';
  expect(encodeOpaqueCursor(schema, { kind: 'example', id: 'one' })).toBe(
    known,
  );
  expect(decodeOpaqueCursor(schema, known)).toEqual({
    kind: 'example',
    id: 'one',
  });
  expect(decodeOpaqueCursor(schema, `${known}=`)).toBeUndefined();
  expect(decodeOpaqueCursor(schema, 'x'.repeat(1025))).toBeUndefined();
  expect(() =>
    encodeOpaqueCursor(schema, { kind: 'other', id: 'one' }),
  ).toThrow();
  expect(() =>
    encodeOpaqueCursor(schema, { kind: 'example', id: 'one', extra: true }),
  ).toThrow();
});
