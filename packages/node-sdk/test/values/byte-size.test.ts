import { describe, expect, it } from 'vitest';
import { formatByteSize, formatCount } from '../../src/index.js';

describe('byte sizes and counts in messages', () => {
  it.each([
    [512, '512 B'],
    [1_024, '1 KB'],
    [8_192, '8 KB'],
    [65_536, '64 KB'],
    [10_000, '10 KB'],
    [1_048_576, '1 MB'],
    [2_516_582, '2.4 MB'],
    [10_485_760, '10 MB'],
    [104_857_600, '100 MB'],
  ])('writes %i bytes as %s', (bytes, text) => {
    expect(formatByteSize(bytes)).toBe(text);
  });

  it('groups counts with commas', () => {
    expect(formatCount(1_000_000)).toBe('1,000,000');
    expect(formatCount(256)).toBe('256');
  });
});
