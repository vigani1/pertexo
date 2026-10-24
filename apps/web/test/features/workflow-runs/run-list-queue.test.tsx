import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowRunListItemSchema,
} from '@pertexo/contracts';
import { RunList } from '@/features/workflow-runs/components/run-list/view';
import { createApiClient } from '@/lib/api/client';
import {
  fixtureIds,
  fixtureRun,
  fixtureWorkspace,
} from '../../support/fixtures/run';
import { renderInRouter } from '../../support/render-in-router';

const workspace = accessibleWorkspaceSchema.parse(
  fixtureWorkspace(['run:read', 'run:cancel']),
);
const apiClient = createApiClient({
  fetch: () => Promise.reject(new Error('no requests expected')),
  readCsrfToken: () => undefined,
});
const blocked = {
  admissionBlockers: {
    asOf: '2026-09-15T10:00:00.000000Z',
    reasons: ['workspace_capacity'],
  },
};

function renderRuns(runs: readonly unknown[]) {
  renderInRouter(
    <RunList
      apiClient={apiClient}
      userId={fixtureIds.user}
      workspace={workspace}
      runs={runs.map((run) => workflowRunListItemSchema.parse(run))}
      variant="workspace"
    />,
  );
}

it('says once why queued runs wait, and keeps each row to its reason', async () => {
  renderRuns([
    fixtureRun(fixtureIds.firstRun, 'queued', blocked),
    fixtureRun(fixtureIds.secondRun, 'queued', blocked),
  ]);
  expect(
    await screen.findByText(
      /2 queued runs are waiting for workspace capacity\./u,
    ),
  ).toBeVisible();
  expect(screen.getAllByText('Waiting for workspace capacity')).toHaveLength(2);
  expect(screen.queryByText(/Observed/u)).toBeNull();
});

it('shows a run being stopped as Stopping until it ends', async () => {
  renderRuns([
    fixtureRun(fixtureIds.firstRun, 'waiting', {
      cancelRequestedAt: '2026-09-15T10:00:01.000Z',
    }),
  ]);
  expect(await screen.findByText('Stopping…')).toBeVisible();
  expect(screen.queryByText('Waiting')).toBeNull();
});
