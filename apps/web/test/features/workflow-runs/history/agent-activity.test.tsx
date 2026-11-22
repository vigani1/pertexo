import { HttpResponse, http } from 'msw';
import { mockServer } from '../../../support/mock-server';
import { renderInRouter } from '../../../support/render-in-router';
import { testFetch } from '../../../support/render-app';
import { RunTimeline } from '@/features/workflow-runs/components/run-detail/timeline/view';
import { RunStepDetails } from '@/features/workflow-runs/components/run-detail/inspection';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AGENT_SEND_SLACK_MESSAGE, AGENT_STEP } from '@pertexo/workflow-model';
import { AgentActivity } from '@/features/workflow-runs/components/run-detail/timeline/agent-activity';
import { buildRunTimeline } from '@/features/workflow-runs/model/timeline/runs';
import { createApiClient } from '@/lib/api/client';
import { describeBrowserStep } from '../../../support/fixtures/node-catalog';
import { fixtureIds, fixtureWorkspace } from '../../../support/fixtures/run';
import { at, node, nodeEvent, runSummary, start } from './timeline/fixture';

it('shows the approved Slack call as unknown and keeps its dispatch evidence visible', () => {
  const parentInvocationKey = 'agent:0';
  const timeline = buildRunTimeline(
    {
      run: runSummary('outcome_unknown'),
      nodes: [
        node('agent', 'succeeded', {
          invocationKey: 'model:1',
          currentAttemptNumber: 0,
          agentApproval: 'approved',
        }),
        node('agent', 'outcome_unknown', {
          invocationKey: 'slack:1',
          dispatchMarkedAt: at(2),
          completedAt: at(3),
        }),
      ],
      events: [
        nodeEvent('node.ready', 1, {
          invocationKey: 'model:1',
          nodeId: 'agent',
          agentWork: {
            parentInvocationKey,
            turn: 1,
            work: { kind: 'model_turn' },
            definition: AGENT_STEP,
          },
        }),
        nodeEvent('node.ready', 2, {
          invocationKey: 'slack:1',
          nodeId: 'agent',
          agentWork: {
            parentInvocationKey,
            turn: 1,
            work: { kind: 'tool_call', ordinal: 1 },
            definition: AGENT_SEND_SLACK_MESSAGE,
            alias: 'message_order',
          },
        }),
      ],
      nowMs: start + 3_000,
    },
    describeBrowserStep,
  );
  render(
    <AgentActivity
      parentKey={parentInvocationKey}
      rows={timeline.rows}
      nowMs={timeline.endMs}
      onSelectStep={() => undefined}
      scope={{
        apiClient: createApiClient({
          fetch: globalThis.fetch,
          readCsrfToken: () => undefined,
        }),
        userId: fixtureIds.user,
        runId: fixtureIds.firstRun,
        workspace: fixtureWorkspace(['workspace:read', 'run:read']),
      }}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Send Slack message · message_order' }),
  ).toBeVisible();
  expect(screen.getByText('Outcome unknown', { exact: true })).toBeVisible();
  expect(screen.getByText('Approved', { exact: true })).toBeVisible();
  expect(screen.getByText(/^Dispatch recorded /u)).toBeVisible();
});

it('shows the Agent before its model turn with the same duration in the timeline and inspector', async () => {
  const parentInvocationKey = 'agent:0';
  const timeline = buildRunTimeline(
    {
      run: runSummary('succeeded', { completedAt: at(10) }),
      nodes: [
        node('agent', 'succeeded', {
          invocationKey: parentInvocationKey,
          startedAt: at(9),
          completedAt: at(9),
        }),
        node('agent', 'succeeded', {
          invocationKey: 'model:1',
          startedAt: at(2),
          completedAt: at(4),
        }),
      ],
      events: [
        nodeEvent('node.started', 2, {
          invocationKey: 'model:1',
          nodeId: 'agent',
          agentWork: {
            parentInvocationKey,
            turn: 1,
            work: { kind: 'model_turn' },
            definition: AGENT_STEP,
          },
        }),
        nodeEvent('node.ready', 9, {
          invocationKey: parentInvocationKey,
          nodeId: 'agent',
        }),
        nodeEvent('node.succeeded', 9, {
          invocationKey: parentInvocationKey,
          nodeId: 'agent',
        }),
      ],
      nowMs: start + 10_000,
    },
    describeBrowserStep,
  );
  const parent = timeline.rows.find(({ key }) => key === parentInvocationKey);
  expect(timeline.rows.map(({ key }) => key)).toEqual([
    parentInvocationKey,
    'model:1',
  ]);
  expect(parent?.segments).toEqual([
    expect.objectContaining({
      kind: 'attempt',
      startMs: start + 2_000,
      endMs: start + 9_000,
    }),
  ]);
  mockServer.use(
    http.get(
      '*/v1/workspaces/:workspaceId/runs/:runId/node-runs/:nodeRunId/output',
      () => HttpResponse.json({ output: { kind: 'none' } }),
    ),
  );
  renderInRouter(
    <>
      <RunTimeline
        view={timeline}
        active={false}
        nowMs={timeline.endMs}
        selectedKey={parentInvocationKey}
        onSelectStep={() => undefined}
      />
      <section aria-label="Inspector">
        <RunStepDetails
          row={parent}
          rows={timeline.rows}
          upstream={undefined}
          nowMs={timeline.endMs}
          scope={{
            apiClient: createApiClient({
              fetch: testFetch,
              readCsrfToken: () => undefined,
            }),
            userId: fixtureIds.user,
            runId: fixtureIds.firstRun,
            workspace: fixtureWorkspace(['workspace:read', 'run:read']),
          }}
        />
      </section>
    </>,
  );
  expect(
    await screen.findByRole('button', { name: 'agent: Succeeded, 7s' }),
  ).toBeVisible();
  expect(
    within(screen.getByRole('region', { name: 'Inspector' })).getByText('7s', {
      exact: true,
    }),
  ).toBeVisible();
});
