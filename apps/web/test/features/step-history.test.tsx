import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  StepHealthList,
  StepHistoryPanel,
} from '@/features/workflow-runs/step-history.public';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../support/mock-server';
import { testFetch } from '../support/render-app';
import { renderInRouter } from '../support/render-in-router';
import { apiBase, fixtureIds, fixtureWorkspace } from '../support/run-fixtures';

const { user: userId, workflow: workflowId, firstRun: runId } = fixtureIds;
const nodeRunId = '44444444-4444-4444-8444-444444444444';
const apiClient = createApiClient({
  fetch: testFetch,
  readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
});
const workspace = fixtureWorkspace([
  'workspace:read',
  'workflow:read',
  'run:read',
  'artifact:read',
]) as AccessibleWorkspace;

const now = Date.now();
const ago = (seconds: number) => new Date(now - seconds * 1_000).toISOString();

function health(items: readonly unknown[], runsConsidered = 12) {
  return http.get(`${apiBase}/workflows/${workflowId}/step-health`, () =>
    HttpResponse.json({ runsConsidered, oldestRunAt: ago(3_600), items }),
  );
}

const chargeHealth = {
  nodeId: 'charge',
  runs: 12,
  succeeded: 10,
  failed: 2,
  skipped: 0,
  lastStatus: 'failed',
  lastRanAt: ago(60),
  medianDurationMs: 300,
  p95DurationMs: 1_200,
};

function stepRun(status: string, seconds: number, extra = {}) {
  return {
    runId,
    runStatus: status === 'failed' ? 'failed' : 'succeeded',
    runCreatedAt: ago(seconds),
    workflowVersionId: fixtureIds.version,
    nodeRunId,
    invocationKey: `${workflowId}|charge|b:|i:`,
    status,
    attempts: 1,
    startedAt: ago(seconds),
    completedAt: ago(seconds - 1),
    safeErrorCode: null,
    ...extra,
  };
}

describe('step history', () => {
  it('shows how a step has been doing, its last result and its latest runs', async () => {
    mockServer.use(
      health([chargeHealth]),
      http.get(`${apiBase}/workflows/${workflowId}/steps/charge/runs`, () =>
        HttpResponse.json({
          items: [
            stepRun('failed', 60, {
              safeErrorCode: 'provider.timeout',
              nodeRunId: '55555555-5555-4555-8555-555555555555',
            }),
            stepRun('succeeded', 360),
          ],
        }),
      ),
      http.get(`${apiBase}/runs/${runId}/node-runs/${nodeRunId}/output`, () =>
        HttpResponse.json({
          output: { kind: 'inline', value: { charged: true } },
        }),
      ),
    );
    renderInRouter(
      <StepHistoryPanel
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        workflowId={workflowId}
        nodeId="charge"
        stepLabel="Charge card"
      />,
    );
    expect(await screen.findByText('12×')).toBeVisible();
    expect(screen.getByText('slowest 1.2s')).toBeVisible();
    // The last result is the latest successful run's output.
    expect(
      await screen.findByRole('group', { name: 'Last result of Charge card' }),
    ).toHaveTextContent(/charged: true/u);
    const recent = screen.getByRole('list');
    const links = within(recent).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent(/Failed/u);
    expect(links[0]).toHaveAttribute(
      'href',
      `/w/${fixtureIds.workspace}/runs/${runId}`,
    );
  });

  it('says when the workflow or the step hasn’t run yet', async () => {
    mockServer.use(
      health([], 12),
      http.get(`${apiBase}/workflows/${workflowId}/steps/new-step/runs`, () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderInRouter(
      <StepHistoryPanel
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        workflowId={workflowId}
        nodeId="new-step"
        stepLabel="New step"
      />,
    );
    expect(
      await screen.findByText(/hasn’t run in the workflow’s last 12 runs/u),
    ).toBeVisible();
  });

  it('lists steps that fail most first, naming removed ones', async () => {
    mockServer.use(
      health([
        { ...chargeHealth, nodeId: 'fetch', failed: 0, succeeded: 12 },
        chargeHealth,
        { ...chargeHealth, nodeId: 'gone', failed: 0, succeeded: 12 },
      ]),
    );
    renderInRouter(
      <StepHealthList
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        workflowId={workflowId}
        labelOf={(nodeId) =>
          ({ fetch: 'Fetch order', charge: 'Charge card' })[nodeId]
        }
      />,
    );
    const rows = await screen.findAllByRole('row');
    expect(rows.slice(1).map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Charge card122/u),
      expect.stringMatching(/^Fetch order/u),
      expect.stringMatching(/^A removed step/u),
    ]);
  });
});
