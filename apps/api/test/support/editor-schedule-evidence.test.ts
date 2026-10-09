import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifiedScheduleAcceptanceInstant } from './editor-schedule-evidence.js';

describe('schedule history precision and original acceptance identity', () => {
  it.each(['000', '148'])(
    'accepts only zero extension of .%s and retains original receipt bytes',
    (fraction) => {
      const original = `2026-09-28T11:06:34.${fraction}Z`;
      const history = `2026-09-28T11:06:34.${fraction}000Z`;
      const verified = verifiedScheduleAcceptanceInstant(original, history);
      expect(verified).toBe(original);
      const hash = (instant: string) =>
        createHash('sha256').update(`trigger:${instant}`).digest('hex');
      expect(hash(verified)).toBe(hash(original));
      expect(hash(verified)).not.toBe(hash(history));
    },
  );
  it.each([
    '2026-09-28T11:06:34.148001Z',
    '2026-09-28T11:06:34.147999Z',
    '2026-09-28T11:06:33.148000Z',
    '2026-09-28T11:06:35.148000Z',
    '2026-09-28T11:06:34.148Z',
    '2026-09-28T11:06:34.1480000Z',
    'not-an-instant',
  ])(
    'rejects a different instant or malformed history precision: %s',
    (history) => {
      expect(() =>
        verifiedScheduleAcceptanceInstant('2026-09-28T11:06:34.148Z', history),
      ).toThrow();
    },
  );
  it.each([
    '2026-09-28T11:06:34.148000Z',
    '2026-09-28T11:06:34Z',
    'not-an-instant',
  ])('rejects altered scanner-format identity: %s', (original) => {
    expect(() =>
      verifiedScheduleAcceptanceInstant(
        original,
        '2026-09-28T11:06:34.148000Z',
      ),
    ).toThrow();
  });
});
