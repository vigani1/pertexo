import { render, screen } from '@testing-library/react';
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
