import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TokenList } from '@/features/api-tokens/components/list';
import { apiTokenMetadataSchema } from '@pertexo/contracts';

afterEach(() => vi.useRealTimers());
it.each(['active', 'revoked', 'membership_changed'] as const)(
  'keeps the mounted %s badge consistent when the deadline passes',
  async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
    const token = apiTokenMetadataSchema.parse({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Build runner',
      scopes: ['run:read'],
      status,
      createdAt: '2026-11-01T10:00:00.000Z',
      expiresAt: '2026-11-08T10:00:30.000Z',
      revokedAt: status === 'revoked' ? '2026-11-08T09:00:00.000Z' : null,
      lastUsedAt: null,
    });
    render(<TokenList tokens={[token]} />);
    if (status === 'active')
      expect(screen.getByText('Active', { exact: true })).toBeVisible();
    await act(() => vi.advanceTimersByTime(60_000));
    expect(
      screen.queryByText('Active', { exact: true }),
    ).not.toBeInTheDocument();
    const expected = {
      active: 'Expired',
      revoked: 'Revoked',
      membership_changed: 'Membership changed',
    };
    expect(screen.getByText(expected[status], { exact: true })).toBeVisible();
  },
);
