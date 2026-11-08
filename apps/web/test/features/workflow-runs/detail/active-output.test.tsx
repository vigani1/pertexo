import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { StepRunOutput } from '@/features/workflow-runs/components/run-detail/data/outputs';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../../support/mock-server';
import { renderInRouter } from '../../../support/render-in-router';
import { testFetch } from '../../../support/render-app';
import { fixtureWorkspace } from '../../../support/fixtures/run';

it('shows recovery for a failed active output read and keeps successful empty output distinct', async () => {
  let failed = true;
  mockServer.use(
    http.get(
      '*/v1/workspaces/:workspaceId/runs/:runId/node-runs/:nodeRunId/output',
      () =>
        failed
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ output: { kind: 'none' } }),
    ),
  );
  renderInRouter(
    <StepRunOutput
      nodeRunId="33333333-3333-4333-8333-333333333333"
      status="running"
      title="Output"
      scope={{
        apiClient: createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        }),
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        workspace: fixtureWorkspace(['workspace:read', 'run:read']),
        runId: '44444444-4444-4444-8444-444444444444',
      }}
    />,
  );
  const retry = await screen.findByRole('button', { name: 'Try again' });
  expect(
    screen.queryByText('Shows up when the step finishes.'),
  ).not.toBeInTheDocument();
  failed = false;
  await userEvent.setup().click(retry);
  expect(
    await screen.findByText('Shows up when the step finishes.'),
  ).toBeVisible();
});
