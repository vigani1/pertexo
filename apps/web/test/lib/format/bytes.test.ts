import { expect, it } from 'vitest';
import { formatByteLength } from '../../../src/lib/format/bytes';

it('formats exact database byte strings and upload lengths in the same binary units', () => {
  expect(formatByteLength('1073741824')).toBe('1 GB');
  expect(formatByteLength('9007199254740993')).toBe('8 PB');
  expect(formatByteLength('0')).toBe('0 B');
  expect(formatByteLength(1536)).toBe('1.5 KB');
  expect(formatByteLength(12)).toBe('12 B');
});
