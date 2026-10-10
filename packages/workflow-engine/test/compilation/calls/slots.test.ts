import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { parseCheckpoint } from '../../../src/index.js';
import { callGraph, completion, runtime } from './fixtures.js';

function withOrdinaryWork(): WorkflowGraph {
  const original = callGraph();
  const parent = original.nodes[0];
  if (parent === undefined) throw new Error('fixture manual missing');
  return {
    ...original,
    nodes: [
      ...original.nodes,
      {
        ...parent,
        id: 'ordinary',
        definition: { key: 'core.set', version: 1 },
        inputMappings: { input: { kind: 'run_input', path: '$' } },
      },
    ],
    edges: [
      ...original.edges,
      {
        id: 'manual-ordinary',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'ordinary', port: 'in' },
      },
    ],
  };
}

describe('parent slot ownership', () => {
  it('fences ready ordinary work without polling and admits it when the slot returns', async () => {
    const run = runtime(withOrdinaryWork());
    const initial = await run.initial();
    const ready = await run.advance(initial.checkpoint, {
      ...completion(initial),
      hasExecutionSlot: false,
    });
    expect(ready.attempts).toEqual([]);
    expect(ready.checkpoint.readySet).toHaveLength(2);
    expect(ready.checkpoint.runStatus).toBe('waiting');
    expect(ready.immediateContinuation).toBeUndefined();
    const blocked = await run.advance(
      parseCheckpoint(JSON.parse(JSON.stringify(ready.checkpoint))),
      { hasExecutionSlot: false },
    );
    expect(blocked.attempts).toEqual([]);
    expect(blocked.events).toEqual([]);
    expect(blocked.immediateContinuation).toBeUndefined();
    const returned = await run.advance(blocked.checkpoint, {
      hasExecutionSlot: true,
    });
    expect(returned.attempts.map(({ nodeId }) => nodeId)).toEqual([
      'call',
      'ordinary',
    ]);
    expect(returned.checkpoint.runStatus).toBe('running');
  });
});
