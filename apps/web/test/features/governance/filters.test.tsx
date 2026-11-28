import { http, HttpResponse } from 'msw';
import { formatCalendarDay } from '@/lib/format/time';
import { coldStart } from '../../support/fixtures/run';
import {
  api,
  identityHandlers,
  ownerWorkspace,
  workspaceId,
} from '../../support/fixtures/team';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AuditFilters } from '@/features/governance/components/audit-filters';

it('applies a person on Enter and narrows by what changed', async () => {
  const onApply = vi.fn(),
    user = userEvent.setup();
  render(<AuditFilters filters={{}} onApply={onApply} />);
  await user.type(
    screen.getByRole('searchbox', { name: 'Person' }),
    'Alice{Enter}',
  );
  expect(onApply).toHaveBeenLastCalledWith({ person: 'Alice' });

  await user.click(screen.getByRole('combobox', { name: 'What changed' }));
  await user.click(await screen.findByRole('option', { name: 'Workflows' }));
  expect(onApply).toHaveBeenLastCalledWith({ targetType: 'workflow' });
});

it('shows a narrowed action as a chip that widens the log again', async () => {
  const onApply = vi.fn(),
    user = userEvent.setup();
  render(
    <AuditFilters
      filters={{ action: 'workflow.published', person: 'Alice' }}
      actionWords="published a workflow"
      onApply={onApply}
    />,
  );
  await user.click(
    screen.getByRole('button', {
      name: 'Show every kind of event, not only “published a workflow”',
    }),
  );
  expect(onApply).toHaveBeenLastCalledWith({ person: 'Alice' });
});

it('applies an Audit date on the first tap and sends the sorted range on the second', async () => {
  const reads: URLSearchParams[] = [];
  mockServer.use(
    ...identityHandlers({
      ...ownerWorkspace,
      capabilities: ['workspace:read', 'audit:read'],
    }),
    http.get(`${api}/governance/audit`, ({ request }) => {
      reads.push(new URL(request.url).searchParams);
      return HttpResponse.json({ items: [], nextCursor: null });
    }),
  );
  await renderLoadedApp(`/w/${workspaceId}/settings/audit`);
  const user = userEvent.setup();
  expect(
    await screen.findByRole('region', { name: 'When it happened' }, coldStart),
  ).toBeVisible();
  const now = new Date();
  const date = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const bounds = () => [reads.at(-1)?.get('from'), reads.at(-1)?.get('until')];
  await user.click(
    await screen.findByRole('button', { name: formatCalendarDay(date(0)) }),
  );
  await waitFor(() => {
    expect(bounds()).toEqual([date(0).toISOString(), date(1).toISOString()]);
  });
  await user.keyboard('{ArrowLeft}');
  await user.click(
    screen.getByRole('button', { name: formatCalendarDay(date(-1)) }),
  );
  await waitFor(() => {
    expect(bounds()).toEqual([date(-1).toISOString(), date(1).toISOString()]);
  });
});
