import { NotificationsProvider } from '@/components/ui/toast';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuditEntry } from '@/features/governance/components/entry';

it.each([
  ['outcome_unknown', 'Outcome unknown'],
  ['succeeded', 'Succeeded'],
  ['failed', 'Failed'],
  ['timed_out', 'Timed out'],
  ['canceled', 'Canceled'],
])(
  'shows a step test’s %s outcome and dry-run mode in its audit entry',
  (status, words) => {
    render(
      <NotificationsProvider>
        <AuditEntry
          workspaceId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          event={{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            actorId: null,
            actorName: null,
            action: 'preview.execution_terminal',
            targetType: 'preview-run',
            targetId: null,
            occurredAt: new Date().toISOString(),
            metadata: { status, dryRun: 'not_supported' },
          }}
          onOnlyAction={vi.fn()}
          onOnlyTarget={vi.fn()}
        />
      </NotificationsProvider>,
    );
    expect(screen.getByText(new RegExp(words))).toBeVisible();
    expect(screen.getByText(/Runs for real/u)).toBeVisible();
  },
);
