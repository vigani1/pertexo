import { describe, expect, it } from 'vitest';
import {
  workflowRunSummarySchema,
  type WorkflowNodeRunSummary,
} from '@pertexo/contracts';
import { lastRunOverlay } from '@/features/workflow-editor/model/canvas/last-run';
import type { GraphLevel } from '@/features/workflow-editor/model/graph/scopes';
import { fixtureRun } from '../../../../support/fixtures/run';

function step(id: string) {
  return {
    id,
    definition: { key: 'core.noop', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

const graph: GraphLevel = {
  nodes: [step('intake'), step('erp'), step('approve'), step('receipt')],
  edges: [
    {
      id: 'intake-erp',
      source: { nodeId: 'intake', port: 'out' },
      target: { nodeId: 'erp', port: 'in' },
    },
    {
      id: 'erp-receipt',
      source: { nodeId: 'erp', port: 'out' },
      target: { nodeId: 'receipt', port: 'in' },
    },
  ],
};

function run(id: string, status: 'failed' | 'running' | 'succeeded') {
  return workflowRunSummarySchema.parse(fixtureRun(id, status));
}

function nodeRun(
  nodeId: string,
  status: WorkflowNodeRunSummary['status'],
  overrides: Partial<WorkflowNodeRunSummary> = {},
): WorkflowNodeRunSummary {
  return {
    id: `${nodeId}-${status}`,
    nodeId,
    invocationKey: nodeId,
    status,
    currentAttemptNumber: 1,
    startedAt: '2026-11-27T10:00:00.000Z',
    completedAt: status === 'running' ? null : '2026-11-27T10:00:02.600Z',
    resumeAt: null,
    ...overrides,
  } as WorkflowNodeRunSummary;
}

describe('the last run under the steps', () => {
  it('says how long each step took, what failed and that the run never reached a step', () => {
    const overlay = lastRunOverlay(
      graph,
      run('20000000-0000-4000-8000-000000000001', 'failed'),
      [
        nodeRun('intake', 'succeeded'),
        nodeRun('erp', 'succeeded'),
        nodeRun('receipt', 'failed', {
          currentAttemptNumber: 3,
          safeErrorCode: 'provider.unavailable',
        }),
      ],
      true,
    );
    expect(Object.fromEntries(overlay.results)).toEqual({
      intake: { kind: 'ran', status: 'succeeded', detail: '2.6s' },
      erp: { kind: 'ran', status: 'succeeded', detail: '2.6s' },
      approve: { kind: 'not-taken' },
      receipt: {
        kind: 'failed',
        code: 'provider.unavailable',
        tries: '3 tries',
      },
    });
    expect(overlay.runningNodeIds.size).toBe(0);
    expect(overlay.liveEdgeIds.size).toBe(0);
  });

  it('breathes on the working step and flows along the link into it while the run is live', () => {
    const overlay = lastRunOverlay(
      graph,
      run('20000000-0000-4000-8000-000000000002', 'running'),
      [nodeRun('intake', 'succeeded'), nodeRun('erp', 'running')],
      false,
    );
    expect([...overlay.runningNodeIds]).toEqual(['erp']);
    expect([...overlay.liveEdgeIds]).toEqual(['intake-erp']);
    // Steps the live run hasn't reached yet simply wait: no result.
    expect(overlay.results.has('receipt')).toBe(false);
    expect(overlay.results.get('erp')).toEqual({
      kind: 'ran',
      status: 'running',
      detail: null,
    });
  });

  it('shows the latest try of a step that ran again', () => {
    const overlay = lastRunOverlay(
      graph,
      run('20000000-0000-4000-8000-000000000003', 'succeeded'),
      [
        nodeRun('receipt', 'failed', {
          id: 'first',
          startedAt: '2026-11-27T10:00:00.000Z',
        }),
        nodeRun('receipt', 'succeeded', {
          id: 'retried',
          startedAt: '2026-11-27T10:05:00.000Z',
          completedAt: '2026-11-27T10:05:00.400Z',
        }),
      ],
      true,
    );
    expect(overlay.results.get('receipt')).toEqual({
      kind: 'ran',
      status: 'succeeded',
      detail: '0.4s',
    });
  });
});
