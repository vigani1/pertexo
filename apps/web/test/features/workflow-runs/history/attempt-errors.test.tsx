import { screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { StepExecutionHistory } from '@/features/workflow-runs/components/run-detail/execution-history';
import type { RunTimelineRow } from '@/features/workflow-runs/model/timeline/runs';
import { renderInRouter } from '../../../support/render-in-router';
import { fixtureWorkspace } from '../../../support/fixtures/run';
const workspace = fixtureWorkspace(['workspace:read', 'run:read']);
const now = Date.now();
const at = new Date(now - 2000).toISOString();
const endedAt = new Date(now - 1000).toISOString();
it.each(['execution.file_input', 'execution.attempt_invalid'])(
  'never borrows the latest diagnostic for an older %s attempt',
  async (olderCode) => {
    const latest = 'Use a date like 2026-10-19.';
    const row: RunTimelineRow = {
      key: 'read',
      nodeId: 'read',
      label: 'Read data',
      status: 'failed',
      tone: 'failure',
      statusLabel: 'Failed',
      attempts: 2,
      currentAttemptNumber: 2,
      segments: [],
      outputs: [],
      safeErrorCode: 'execution.attempt_invalid',
      errorSummary: latest,
      story: [
        {
          id: 'first',
          kind: 'attempt',
          outcome: 'failed',
          tone: 'failure',
          startedAt: at,
          endedAt,
          attemptNumber: 1,
          safeErrorCode: olderCode,
        },
        {
          id: 'second',
          kind: 'attempt',
          outcome: 'failed',
          tone: 'failure',
          startedAt: endedAt,
          endedAt,
          attemptNumber: 2,
          safeErrorCode: 'execution.attempt_invalid',
        },
      ],
    };
    renderInRouter(
      <StepExecutionHistory row={row} nowMs={now} workspace={workspace} />,
    );
    const entries = await screen.findAllByRole('listitem');
    expect(entries).toHaveLength(2);
    for (const [index, entry] of entries.entries()) {
      if (index === 0) expect(within(entry).queryByText(latest)).toBeNull();
      else expect(within(entry).getByText(latest)).toBeVisible();
    }
    expect(screen.getAllByText(latest)).toHaveLength(1);
  },
);
