import { describe, expect, it } from 'vitest';
import { formatByteSize, formatCount } from '../../src/index.js';

describe('byte sizes and counts in messages', () => {
  it.each([
    [512, '512 B'],
    [1_024, '1 KB'],
    [8_192, '8 KB'],
    [65_536, '64 KB'],
    [1_536, '1.5 KB'],
    [1_048_576, '1 MB'],
    [1_572_864, '1.5 MB'],
    [1_049_600, '1,025 KB'],
    [10_485_760, '10 MB'],
    [104_857_600, '100 MB'],
  ])('writes %i bytes as %s', (bytes, text) => {
    expect(formatByteSize(bytes)).toBe(text);
  });

  it.each([
    [1_600, '1,600 B'],
    [10_000, '10,000 B'],
    [2_516_582, '2,516,582 B'],
  ])(
    'writes %i bytes exactly rather than round them to another size',
    (bytes, text) => {
      expect(formatByteSize(bytes)).toBe(text);
    },
  );

  it('groups counts with commas', () => {
    expect(formatCount(1_000_000)).toBe('1,000,000');
    expect(formatCount(256)).toBe('256');
  });
});
