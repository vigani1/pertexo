import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoomRunList } from '@/features/workflow-runs/components/loom/loom-run-list';
import type { LoomModel, LoomRun } from '@/features/workflow-runs/model/loom';
import { renderInRouter } from '../support/render-in-router';

const run: LoomRun = {
  id: '01a0d944-1d79-7339-b09d-5880103b33dc',
  workflowId: '01a0d943-f7b8-766d-bd35-605e8e4babe2',
  workflowName: 'Invoice intake',
  status: 'succeeded',
  tone: 'success',
  startMs: 0,
  endMs: 1_500,
  createdAt: '2026-09-25T15:51:00.000Z',
};

function model(overrides: Partial<LoomModel>): LoomModel {
  return {
    windowMs: 3_600_000,
    lanes: [{ key: run.workflowId, label: run.workflowName, runs: [run] }],
    runCount: 1,
    liveCount: 0,
    hiddenLaneCount: 0,
    ticks: [],
    ...overrides,
  };
}

describe('Loom run list', () => {
  it('names a single run and a single hidden workflow in the singular', async () => {
    renderInRouter(
      <LoomRunList
        model={model({ hiddenLaneCount: 1 })}
        workspaceId="01a0d5c8-246f-776c-b931-fef581c67863"
        windowLabel="the last hour"
      />,
    );

    expect(
      await screen.findByText(
        'List the run on this timeline (and 1 more workflow not drawn)',
      ),
    ).toBeInTheDocument();
  });

  it('counts several runs and hidden workflows', async () => {
    renderInRouter(
      <LoomRunList
        model={model({ runCount: 3, hiddenLaneCount: 2 })}
        workspaceId="01a0d5c8-246f-776c-b931-fef581c67863"
        windowLabel="the last hour"
      />,
    );

    expect(
      await screen.findByText(
        'List the 3 runs on this timeline (and 2 more workflows not drawn)',
      ),
    ).toBeInTheDocument();
  });
});
