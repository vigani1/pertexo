import { expect, it } from 'vitest';
import { formatCount } from '@/lib/format/count';

it('puts the noun in the number its count needs', () => {
  expect(formatCount(1, 'pinned step')).toBe('1 pinned step');
  expect(formatCount(0, 'case')).toBe('0 cases');
  expect(formatCount(2, 'step')).toBe('2 steps');
  expect(formatCount(1, 'entry', 'entries')).toBe('1 entry');
  expect(formatCount(12_000, 'entry', 'entries')).toBe('12,000 entries');
});
