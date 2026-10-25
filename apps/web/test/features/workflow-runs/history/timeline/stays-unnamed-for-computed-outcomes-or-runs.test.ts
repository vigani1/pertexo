// @vitest-environment node
import { runEnding } from '@/features/workflow-runs/model/presentation/run-sentence';

import { describeRunEvent } from '@/features/workflow-runs/model/timeline/event-copy';

import { describe, expect, it } from 'vitest';

import { nodeEvent, start } from './fixture';

describe('a run’s ending', () => {
  it('stays unnamed for computed outcomes or runs without a Stop run step', () => {
    const graph =
      /* The sentence presenter reads only the supplied terminal output fields from this historical-run fixture. */ {
        nodes: [
          {
            id: 'computed',
            inputMappings: {
              outcome: { kind: 'node_output', nodeId: 'a', path: '$' },
            },
          },
        ],
      } as unknown as Parameters<typeof runEnding>[1];
    expect(
      runEnding(
        [
          {
            nodeId: 'computed',
            definitionKey: 'core.terminate',
            status: 'succeeded',
          },
        ],
        graph,
      ),
    ).toBeUndefined();
    expect(runEnding([], graph)).toBeUndefined();
  });
});

it('names a callback completion without exposing its request credential', () => {
  expect(
    describeRunEvent(
      nodeEvent('node.succeeded', 5, { reasonCode: 'callback.received' }),
      start,
      () => 'Wait',
    ),
  ).toMatchObject({ sentence: 'resumed after callback', tone: 'success' });
});
