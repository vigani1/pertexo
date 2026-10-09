import { describe, expect, it } from 'vitest';
import { workflowForEachBoundsV2 } from '../src/graph/control-output-selection.js';
import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '../src/graph/contract.js';

const ordinary = (id: string) => ({
  id,
  definition: { key: 'core.set', version: 1 },
  config: { items: [1, 2, 3, 4], iterationCount: 4 },
});
const loop = (id: string, nodes: unknown[] = []) => ({
  id,
  definition: { key: 'core.foreach', version: 1 },
  structured: {
    kind: 'for_each',
    maxIterations: 3,
    maxConcurrency: 1,
    body: { nodes },
  },
});
const envelope = (nodes: unknown[]) => ({ schemaVersion: 2, graph: { nodes } });

describe('compiled For Each bounds selection', () => {
  it('selects pinned bounds and ordered ancestry, never loop-shaped ordinary data', () => {
    const source = envelope([
      ordinary('set'),
      loop('outer', [loop('inner', [loop('deep')]), ordinary('body-set')]),
      loop('sibling'),
    ]);
    const before = JSON.stringify(source);
    const selected = workflowForEachBoundsV2(source);
    expect(selected.size).toBe(4);
    expect(selected.get('set')).toBeUndefined();
    expect(selected.get('body-set')).toBeUndefined();
    expect(selected.get('outer')).toEqual({
      maxIterations: 3,
      maxConcurrency: 1,
      ancestorLoopNodeIds: [],
    });
    expect(selected.get('inner')?.ancestorLoopNodeIds).toEqual(['outer']);
    expect(selected.get('deep')?.ancestorLoopNodeIds).toEqual([
      'outer',
      'inner',
    ]);
    expect(selected.get('sibling')?.ancestorLoopNodeIds).toEqual([]);
    expect(Object.isFrozen(selected.get('deep'))).toBe(true);
    expect(Object.isFrozen(selected.get('deep')?.ancestorLoopNodeIds)).toBe(
      true,
    );
    expect(JSON.stringify(source)).toBe(before);
  });

  it('skips retained unstructured and unrecognized foreach versions', () => {
    expect(
      workflowForEachBoundsV2(
        envelope([
          { id: 'legacy', definition: { key: 'core.foreach', version: 1 } },
          { id: 'future', definition: { key: 'core.foreach', version: 2 } },
        ]),
      ).size,
    ).toBe(0);
  });

  it.each([
    null,
    [],
    { schemaVersion: 1, graph: { nodes: [] } },
    { schemaVersion: 2 },
    envelope([null]),
    envelope([{ id: '', definition: { key: 'core.set', version: 1 } }]),
    envelope([{ id: 'n', definition: { key: '', version: 1 } }]),
    envelope([{ id: 'n', definition: { key: 'core.set', version: 0 } }]),
    envelope([{ id: 'n', definition: { key: 'core.set', version: 1.5 } }]),
    envelope([ordinary('same'), loop('outer', [ordinary('same')])]),
    envelope([{ ...loop('n'), structured: null }]),
    envelope([
      { ...loop('n'), structured: { ...loop('n').structured, kind: 'other' } },
    ]),
    envelope([{ ...loop('n'), definition: { key: 'core.set', version: 1 } }]),
    envelope([
      { ...loop('n'), definition: { key: 'core.foreach', version: 2 } },
    ]),
    envelope([
      { ...loop('n'), structured: { ...loop('n').structured, body: {} } },
    ]),
  ])('rejects malformed compiled identity/structure %j', (value) => {
    expect(() => workflowForEachBoundsV2(value)).toThrow(TypeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null])(
    'rejects invalid numeric loop bound %j',
    (value) => {
      for (const field of ['maxIterations', 'maxConcurrency']) {
        const node = loop('n');
        const candidate = {
          ...node,
          structured: { ...node.structured, [field]: value },
        };
        expect(() => workflowForEachBoundsV2(envelope([candidate]))).toThrow(
          TypeError,
        );
      }
    },
  );

  it('enforces existing contract maxima and concurrency intersection', () => {
    const node = loop('n');
    const withBounds = (maxIterations: number, maxConcurrency: number) =>
      envelope([
        {
          ...node,
          structured: { ...node.structured, maxIterations, maxConcurrency },
        },
      ]);
    const { maxLoopIterations, maxLoopConcurrency } =
      WORKFLOW_GRAPH_CONTRACT_LIMITS;
    expect(
      workflowForEachBoundsV2(
        withBounds(maxLoopIterations, maxLoopConcurrency),
      ).get('n')?.maxIterations,
    ).toBe(maxLoopIterations);
    expect(() =>
      workflowForEachBoundsV2(withBounds(maxLoopIterations + 1, 1)),
    ).toThrow();
    expect(() => workflowForEachBoundsV2(withBounds(3, 4))).toThrow();
    expect(() =>
      workflowForEachBoundsV2(
        withBounds(maxLoopIterations, maxLoopConcurrency + 1),
      ),
    ).toThrow();
  });

  it('bounds all visited nodes including ordinary identities', () => {
    expect(
      workflowForEachBoundsV2(
        envelope(
          Array.from({ length: 10_000 }, (_, i) => ordinary(`n-${String(i)}`)),
        ),
      ).size,
    ).toBe(0);
    expect(() =>
      workflowForEachBoundsV2(
        envelope(
          Array.from({ length: 10_001 }, (_, i) => ordinary(`n-${String(i)}`)),
        ),
      ),
    ).toThrow(RangeError);
  });

  it('accepts depth 32 and rejects depth 33', () => {
    const nested = (depth: number): unknown => {
      let graph: unknown[] = [ordinary('leaf')];
      for (let i = depth - 1; i >= 0; i--)
        graph = [loop(`loop-${String(i)}`, graph)];
      return envelope(graph);
    };
    expect(workflowForEachBoundsV2(nested(32)).size).toBe(32);
    expect(() => workflowForEachBoundsV2(nested(33))).toThrow(RangeError);
  });
});
