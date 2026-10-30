import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SkipHistory } from '@/features/workflow-settings/components/settings/concurrency/history';

function skips(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    triggerType: 'webhook' as const,
    reason: 'concurrency_limit' as const,
    at: '2026-10-20T10:00:00.000000Z',
  }));
}

// The settings read returns at most the 20 latest skips.
it.each([
  { count: 20, cut: true },
  { count: 19, cut: false },
])(
  'says the list is cut only when it holds the 20 latest ($count)',
  ({ count, cut }) => {
    render(<SkipHistory items={skips(count)} />);
    expect(screen.getAllByText('Webhook skipped')).toHaveLength(count);
    expect(
      screen.queryByText(
        'Showing the latest 20. Usage includes all retained skips.',
      ) !== null,
    ).toBe(cut);
  },
);
