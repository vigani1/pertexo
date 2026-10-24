import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ComponentProps } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RunDetailTabs } from '@/features/workflow-runs/components/run-detail/tabs';
import type { RunTimelineRow } from '@/features/workflow-runs/model/timeline/runs';
import { createApiClient } from '@/lib/api/client';
import { testFetch } from '../../../support/render-app';
import { fixtureIds, fixtureWorkspace } from '../../../support/fixtures/run';

it('pages maximum-size histories and follows a newly inspected step without losing manual navigation', async () => {
  const user = userEvent.setup();
  const rows: RunTimelineRow[] = Array.from({ length: 5_000 }, (_, index) => ({
    key: String(index),
    nodeId: 'item',
    label: `Item ${String(index + 1)}`,
    status: 'succeeded',
    statusLabel: 'Succeeded',
    tone: 'success',
    attempts: 1,
    segments: [],
    story: [],
    outputs: [],
  }));
  const props: ComponentProps<typeof RunDetailTabs> = {
    scope: {
      apiClient: createApiClient({
        fetch: testFetch,
        readCsrfToken: () => undefined,
      }),
      userId: fixtureIds.user,
      workspace: fixtureWorkspace([
        'workspace:read',
        'run:read',
      ]) as AccessibleWorkspace,
      runId: fixtureIds.firstRun,
    },
    replay: { canReplay: false, onReplay: vi.fn() },
    thread: {
      view: { startMs: 0, endMs: 1_000, rows, ticks: [] },
      nowMs: 1_000,
      active: false,
      selectedKey: undefined,
      onSelectStep: vi.fn(),
    },
    graphSource: { graph: undefined, graphState: 'forbidden' },
    eventStream: {
      events: [],
      truncatedCount: 0,
      recoveryMessage: undefined,
      stepLabel: () => undefined,
      runStartMs: 0,
    },
    compact: true,
  };
  const result = render(<RunDetailTabs {...props} />);
  const pager = screen.getByRole('navigation', { name: 'Step history pages' });
  expect(pager).toHaveTextContent('1–50 of 5,000');
  expect(screen.getAllByRole('button', { name: /^Item /u })).toHaveLength(50);
  expect(
    within(pager).getByRole('button', { name: 'Previous' }),
  ).toBeDisabled();
  await user.click(within(pager).getByRole('button', { name: 'Next' }));
  expect(pager).toHaveTextContent('51–100 of 5,000');
  result.rerender(
    <RunDetailTabs
      {...props}
      thread={{ ...props.thread, selectedKey: '4999' }}
    />,
  );
  expect(pager).toHaveTextContent('4,951–5,000 of 5,000');
  expect(
    screen.getByRole('button', { name: 'Item 5000: Succeeded' }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(within(pager).getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(within(pager).getByRole('button', { name: 'Previous' }));
  result.rerender(
    <RunDetailTabs
      {...props}
      thread={{ ...props.thread, selectedKey: '4999', nowMs: 2_000 }}
    />,
  );
  expect(pager).toHaveTextContent('4,901–4,950 of 5,000');
  result.rerender(
    <RunDetailTabs
      {...props}
      thread={{
        ...props.thread,
        selectedKey: '4999',
        view: { ...props.thread.view, rows: rows.slice(0, 60) },
      }}
    />,
  );
  expect(pager).toHaveTextContent('51–60 of 60');
});
