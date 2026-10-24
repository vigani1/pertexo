import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { RunStepDetails } from '@/features/workflow-runs/components/run-detail/inspection';
import type { RunTimelineRow } from '@/features/workflow-runs/model/timeline/runs';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import {
  apiBase,
  fixtureIds,
  fixtureWorkspace,
} from '../../support/fixtures/run';

it('reads the new run’s owned saved output without fetching expired source data or inventing input', async () => {
  const copyId = '33333333-3333-4333-8333-333333333333';
  const readPaths: string[] = [];
  mockServer.use(
    http.get(
      `${apiBase}/runs/:runId/node-runs/:nodeRunId/:kind`,
      ({ request, params }) => {
        readPaths.push(new URL(request.url).pathname);
        if (
          params.runId !== fixtureIds.replayRun ||
          params.nodeRunId !== copyId ||
          params.kind !== 'output'
        )
          return HttpResponse.json({ output: { kind: 'expired' } });
        return HttpResponse.json({
          output: { kind: 'inline', value: { selectedPort: 'true' } },
        });
      },
    ),
  );
  const row: RunTimelineRow = {
    key: copyId,
    nodeId: 'condition',
    nodeRunId: copyId,
    label: 'Should send',
    status: 'succeeded',
    statusLabel: 'Reused',
    tone: 'success',
    attempts: 0,
    segments: [],
    story: [],
    outputs: [],
    reused: {
      sourceRunId: fixtureIds.firstRun,
      sourceNodeRunId: fixtureIds.secondRun,
      sourceCompletedAt: '2026-10-13T00:00:00.000Z',
    },
  };
  renderInRouter(
    <RunStepDetails
      row={row}
      rows={[row]}
      upstream={new Map()}
      nowMs={Date.now()}
      scope={{
        apiClient: createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        }),
        userId: fixtureIds.user,
        workspace: fixtureWorkspace(['workspace:read', 'run:read']),
        runId: fixtureIds.replayRun,
      }}
    />,
  );
  expect(
    await screen.findByRole('group', { name: 'Data out of Should send' }),
  ).toHaveTextContent(/selectedPort: “true”/u);
  expect(screen.getByText(/This step was not executed here/u)).toBeVisible();
  expect(screen.getByText(/No input was sent/u)).toBeVisible();
  expect(screen.getByRole('link', { name: /run eeee/u })).toHaveAttribute(
    'href',
    `/w/${fixtureIds.workspace}/runs/${fixtureIds.firstRun}`,
  );
  expect(readPaths).toEqual([
    `/v1/workspaces/${fixtureIds.workspace}/runs/${fixtureIds.replayRun}/node-runs/${copyId}/output`,
  ]);
  expect(screen.queryByText(/attempt 1/u)).not.toBeInTheDocument();
});
