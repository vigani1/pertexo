import { expect, it } from 'vitest';

import {
  accept,
  childGraph,
  edge,
  fixture,
  node,
  publishGraph,
  runtime,
} from '../fixtures.js';

export function registerExecutesPrunesCallsTwoSerialEach(): void {
  it('executes and prunes Calls in two serial For Each iterations', async () => {
    const child = await publishGraph(childGraph());
    const graph = {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('loop', 'core.foreach'),
          inputMappings: {
            items: {
              kind: 'literal' as const,
              value: [{ name: 'Ada' }, { name: 'Bob' }],
            },
          },
          structured: {
            kind: 'for_each' as const,
            maxIterations: 2,
            maxConcurrency: 1,
            body: {
              settings: {},
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
              edges: [],
              nodes: [
                {
                  ...node('body', 'core.call'),
                  config: { target: { ...child.pin } },
                  inputMappings: {
                    input: {
                      kind: 'structured_input' as const,
                      port: 'item',
                      path: '$',
                    },
                  },
                },
              ],
            },
          },
        },
        node('finish', 'core.terminate'),
      ],
      edges: [edge('manual', 'loop'), edge('loop', 'finish')],
    };
    const parent = await publishGraph(graph);
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      });
      expect(
        await fixture.workerQuery(
          'select status,result_ref,slot_lent,consumed_at is not null consumed from app.workflow_calls where parent_run_id=$1 order by invocation_key',
          [accepted.runId],
        ),
      ).toEqual([
        {
          status: 'succeeded',
          result_ref: { kind: 'inline', value: 'Ada!' },
          slot_lent: false,
          consumed: true,
        },
        {
          status: 'succeeded',
          result_ref: { kind: 'inline', value: 'Bob!' },
          slot_lent: false,
          consumed: true,
        },
      ]);
      const checkpoint = await fixture.workerQuery<{
        scheduler_state: {
          invocations: { nodeId: string }[];
          loops: { completedPrefix: number }[];
        };
      }>(
        'select scheduler_state from app.run_checkpoints where workflow_run_id=$1',
        [accepted.runId],
      );
      expect(
        checkpoint[0]?.scheduler_state.invocations.some(
          ({ nodeId }) => nodeId === 'body',
        ),
      ).toBe(false);
      expect(checkpoint[0]?.scheduler_state.loops[0]?.completedPrefix).toBe(2);
    } finally {
      await workers.close();
    }
  }, 30_000);
}
