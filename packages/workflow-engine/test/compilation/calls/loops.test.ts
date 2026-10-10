import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { parseCheckpoint } from '../../../src/index.js';
import { invocationKey } from '../../../src/transition/scheduling/loops.js';
import { forEachGraph } from '../../support/executable-workflow.js';
import { childOutcome, completion, runtime, target } from './fixtures.js';

function graphWithCallSink(): WorkflowGraph {
  const original = forEachGraph();
  return {
    ...original,
    nodes: original.nodes.map((node) => {
      if (node.id !== 'loop' || !('structured' in node)) return node;
      const source = node.structured.body.nodes[0];
      if (source === undefined) throw new Error('fixture body missing');
      return {
        ...node,
        structured: {
          ...node.structured,
          maxConcurrency: 1,
          body: {
            ...node.structured.body,
            nodes: [
              {
                ...source,
                id: 'body-call',
                definition: { key: 'core.call', version: 1 },
                config: { target },
                inputMappings: {
                  input: { kind: 'structured_input', port: 'item', path: '$' },
                },
              },
            ],
            edges: [],
          },
        },
      };
    }),
  };
}

describe('Call ownership inside pruned loops', () => {
  it('retains a waiting Call, prunes its completed scope and ignores its retained duplicate fact', async () => {
    const run = runtime(graphWithCallSink());
    const initial = await run.initial();
    const collection = await run.advance(
      initial.checkpoint,
      completion(initial),
    );
    const first = await run.advance(
      collection.checkpoint,
      completion(collection, { items: ['first', 'second'], iterationCount: 2 }),
    );
    expect(first.attempts[0]?.nodeId).toBe('body-call');
    const waiting = await run.advance(
      first.checkpoint,
      completion(first, 'first'),
    );
    expect(waiting.checkpoint.loops[0]?.completedPrefix).toBe(0);
    expect(waiting.checkpoint.loops[0]?.activeOrdinals).toEqual([0]);
    expect(waiting.attempts).toEqual([]);
    const recovered = parseCheckpoint(
      JSON.parse(JSON.stringify(waiting.checkpoint)),
    );
    const fact = childOutcome(waiting);
    const next = await run.advance(recovered, { callOutcomes: [fact] });
    expect(next.checkpoint.loops[0]?.completedPrefix).toBe(1);
    expect(next.prunedInvocations).toContainEqual(
      expect.objectContaining({
        invocationKey: fact.invocationKey,
        output: { kind: 'call', callId: fact.callId },
      }),
    );
    expect(
      next.checkpoint.invocations.some(
        ({ invocationKey }) => invocationKey === fact.invocationKey,
      ),
    ).toBe(false);
    expect(next.checkpoint.admittedInvocationKeys).not.toContain(
      fact.invocationKey,
    );
    expect(next.attempts[0]?.iterationPath).toEqual([
      { loopNodeId: 'loop', ordinal: 1 },
    ]);
    const inventedScope = [
      ...(fact.iterationPath ?? []),
      { loopNodeId: 'invented-loop', ordinal: 0 },
    ];
    await expect(
      run.advance(next.checkpoint, {
        callOutcomes: [
          {
            ...fact,
            iterationPath: inventedScope,
            invocationKey: invocationKey({
              workflowVersionId: next.checkpoint.workflowVersionId,
              nodeId: fact.nodeId,
              branchPath: [],
              iterationPath: inventedScope,
            }),
          },
        ],
      }),
    ).rejects.toThrow(/scope/u);
    const replay = await run.advance(next.checkpoint, { callOutcomes: [fact] });
    expect(replay.events).toEqual([]);
    expect(replay.attempts).toEqual([]);
    const waitingAgain = await run.advance(
      replay.checkpoint,
      completion(next, 'second'),
    );
    expect(waitingAgain.checkpoint.loops[0]?.completedPrefix).toBe(1);
    const second = childOutcome(waitingAgain);
    const exhausted = await run.advance(waitingAgain.checkpoint, {
      callOutcomes: [fact, second],
    });
    expect(exhausted.checkpoint.loops[0]?.completedPrefix).toBe(2);
    expect(exhausted.checkpoint.loops[0]?.activeOrdinals).toEqual([]);
    expect(
      exhausted.checkpoint.invocations.some(
        ({ nodeId }) => nodeId === 'body-call',
      ),
    ).toBe(false);
    expect(exhausted.immediateContinuation).toBe(true);
    const downstream = await run.advance(exhausted.checkpoint);
    expect(downstream.attempts[0]?.nodeId).toBe('terminate');
    const finished = await run.advance(
      downstream.checkpoint,
      completion(downstream),
    );
    expect(finished.checkpoint.runStatus).toBe('succeeded');
  });

  it('does not mistake a successful Call declaration at the body sink for iteration settlement', async () => {
    const run = runtime(graphWithCallSink());
    const initial = await run.initial();
    const collection = await run.advance(
      initial.checkpoint,
      completion(initial),
    );
    const call = await run.advance(
      collection.checkpoint,
      completion(collection, { items: ['item'], iterationCount: 1 }),
    );
    const waiting = await run.advance(
      call.checkpoint,
      completion(call, { declaredOnly: true }),
    );
    expect(waiting.checkpoint.loops[0]?.activeOrdinals).toEqual([0]);
    expect(waiting.checkpoint.loops[0]?.terminalOrdinals).toEqual([]);
    expect(
      waiting.checkpoint.invocations.find(({ nodeId }) => nodeId === 'loop')
        ?.status,
    ).toBe('waiting');
    expect(
      waiting.checkpoint.invocations.find(
        ({ nodeId }) => nodeId === 'body-call',
      )?.status,
    ).toBe('waiting');
  });
});
