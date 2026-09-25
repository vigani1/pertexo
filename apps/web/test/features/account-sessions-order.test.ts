import { describe, expect, it } from 'vitest';
import { orderSessions } from '@/features/auth/model/sessions';

function session(id: string, updatedAt: string, current = false) {
  return {
    id,
    current,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt,
    expiresAt: '2026-10-01T08:00:00.000Z',
    ipAddress: null,
    userAgent: null,
  };
}

describe('account sessions order', () => {
  it('puts this device first, then the most recently active', () => {
    const ordered = orderSessions([
      session('a', '2026-09-20T08:00:00.000Z'),
      session('b', '2026-09-24T08:00:00.000Z'),
      session('here', '2026-09-10T08:00:00.000Z', true),
      session('c', '2026-09-22T08:00:00.000Z'),
    ]);
    expect(ordered.map(({ id }) => id)).toEqual(['here', 'b', 'c', 'a']);
  });
});
