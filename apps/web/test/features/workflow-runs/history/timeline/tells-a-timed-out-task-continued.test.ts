// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { storyEntryReason } from '@/features/workflow-runs/model/step-inspection/copy';
import { describeRunEvent } from '@/features/workflow-runs/model/timeline/event-copy';
import { projectRunGraph } from '@/features/workflow-runs/model/timeline/run-graph';
import { at, nodeEvent, start } from './fixture';

describe('a task nobody answered that continued on Timed out', () => {
  it('reads as a success that took the Timed out path', () => {
    expect(
      describeRunEvent(
        nodeEvent('node.succeeded', 5, {
          reasonCode: 'pending_task.timed_out',
        }),
        start,
        () => 'Manager approval',
      ),
    ).toMatchObject({
      step: 'Manager approval',
      sentence: 'nobody responded · continued on Timed out',
      tone: 'success',
    });
    expect(
      storyEntryReason({
        id: 'event-5:attempt',
        kind: 'attempt',
        outcome: 'succeeded',
        tone: 'success',
        startedAt: at(1),
        endedAt: at(5),
        reasonCode: 'pending_task.timed_out',
      }),
    ).toBe('Nobody responded in time, so the run continued on Timed out.');
  });

  it('labels its link on the run map as the Timed out path', () => {
    const node = (id: string, key: string) => ({
      id,
      definition: { key, version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    });
    const graph: WorkflowGraphContract = {
      settings: {},
      nodes: [node('review', 'core.approval'), node('escalate', 'core.set')],
      edges: [
        {
          id: 'late',
          source: { nodeId: 'review', port: 'timed_out' },
          target: { nodeId: 'escalate', port: 'in' },
        },
      ],
    };
    expect(projectRunGraph(graph, []).edges).toMatchObject([
      { branch: 'Timed out', timedOut: true },
    ]);
  });
});
