import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseWorkflowExecutable,
  verifyWorkflowExecutable,
} from '../../../src/index.js';
import {
  nodeCatalog,
  conditionGraph,
  switchGraph,
  parallelGraph,
  directPairedParallelGraph,
  graph,
  forEachGraph,
} from '../../support/executable-workflow.js';
describe('workflow executable identity', () => {
  it('excludes canvas notes from the executable and keeps its exact checksum', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const original = graph();
    const before = buildWorkflowExecutable({ graph: original, catalog });
    const documented = buildWorkflowExecutable({
      graph: {
        ...original,
        notes: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            text: '# Documentation',
            position: { x: -40, y: 90 },
            size: { width: 320, height: 200 },
            color: 'violet',
          },
        ],
      },
      catalog,
    });
    expect(documented.envelope).toEqual(before.envelope);
    expect(documented.checksum).toBe(before.checksum);
  });
  it('pins retry settings and loads them without changing legacy executable identity', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const original = graph();
    const baseline = buildWorkflowExecutable({ graph: original, catalog });
    expect(baseline.checksum).toBe(
      'wf:sha256:bc624efc7e092d274f7655954b21da21501b8ac128fafb5095fdd91e7bb1e6d7',
    );
    const configured = buildWorkflowExecutable({
      graph: {
        ...original,
        nodes: original.nodes.map((node) =>
          node.id === 'set'
            ? { ...node, retry: { maximumAttempts: 5, delayMillis: 4_000 } }
            : node,
        ),
      },
      catalog,
    });
    expect(configured.checksum).not.toBe(baseline.checksum);
    const loaded = verifyWorkflowExecutable({
      envelope: JSON.parse(JSON.stringify(configured.envelope)),
      checksum: configured.checksum,
      catalog,
    });
    expect(
      loaded.envelope.graph.nodes.find((node) => node.id === 'set')?.retry,
    ).toEqual({ maximumAttempts: 5, delayMillis: 4_000 });
    expect(
      baseline.envelope.graph.nodes.every(
        (node) => !Object.hasOwn(node, 'retry'),
      ),
    ).toBe(true);
  });
  it('retains and validates retry settings inside a For each body', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ forEach: true }));
    const nested = forEachGraph();
    const loop = nested.nodes.find((node) => node.id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('The loop must exist');
    const action = loop.structured.body.nodes.find(
      (node) => node.id === 'body-first',
    );
    if (action === undefined) throw new Error('The body action must exist');
    Object.assign(action, {
      retry: { maximumAttempts: 5, delayMillis: 60_000 },
    });
    const executable = buildWorkflowExecutable({ graph: nested, catalog });
    const loaded = verifyWorkflowExecutable({
      envelope: JSON.parse(JSON.stringify(executable.envelope)),
      checksum: executable.checksum,
      catalog,
    });
    expect(
      loaded.envelope.graph.nodes
        .find((node) => node.id === 'loop')
        ?.structured?.body.nodes.find((node) => node.id === 'body-first')
        ?.retry,
    ).toEqual({ maximumAttempts: 5, delayMillis: 60_000 });
    Object.assign(action, {
      retry: { maximumAttempts: 6, delayMillis: 60_000 },
    });
    expect(() => buildWorkflowExecutable({ graph: nested, catalog })).toThrow();
  });
  it('retains callable contracts and includes every declaration in the immutable identity', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const callable = {
      input: { type: 'string' },
      resultType: { type: 'string' },
      result: { kind: 'run_input', path: '$' },
    } as const;
    const executable = buildWorkflowExecutable({
      graph: { ...graph(), callable },
      catalog,
    });
    expect(
      parseWorkflowExecutable({
        envelope: JSON.parse(JSON.stringify(executable.envelope)),
        catalog,
      }).graph.callable,
    ).toEqual(callable);
    const original = executable.checksum;
    for (const changed of [
      { ...callable, input: { type: 'number' } as const },
      { ...callable, resultType: { type: 'number' } as const },
      { ...callable, result: { kind: 'literal', value: 'fixed' } as const },
    ]) {
      const revised = buildWorkflowExecutable({
        graph: { ...graph(), callable: changed },
        catalog,
      });
      expect(revised.checksum).not.toBe(original);
      expect(() =>
        verifyWorkflowExecutable({
          envelope: revised.envelope,
          checksum: original,
          catalog,
        }),
      ).toThrow();
    }
  });
  it('rejects a Condition edge through an undeclared output port', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ condition: true }));

    expect(() =>
      buildWorkflowExecutable({
        graph: conditionGraph('out'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('rejects Condition branches that reconverge before Merge exists', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ condition: true }));
    const reconverging = conditionGraph('true');

    expect(() =>
      buildWorkflowExecutable({
        graph: {
          ...reconverging,
          edges: [
            ...reconverging.edges,
            {
              id: 'condition-false-terminate',
              source: { nodeId: 'condition', port: 'false' },
              target: { nodeId: 'terminate', port: 'in' },
            },
          ],
        },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('rejects Switch edges through unconfigured cases and pre-Merge reconvergence', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ switch: true }));
    expect(() =>
      buildWorkflowExecutable({
        graph: switchGraph('case-03'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const reconverging = switchGraph('case-02');
    expect(() =>
      buildWorkflowExecutable({
        graph: {
          ...reconverging,
          edges: [
            ...reconverging.edges,
            {
              id: 'switch-default-terminate',
              source: { nodeId: 'switch', port: 'default' },
              target: { nodeId: 'terminate', port: 'in' },
            },
          ],
        },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('requires every declared Parallel branch exactly once without pre-Merge reconvergence', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ parallel: true }));
    expect(() =>
      buildWorkflowExecutable({
        graph: parallelGraph('branch-03'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const missing = parallelGraph();
    expect(() =>
      buildWorkflowExecutable({
        graph: { ...missing, edges: missing.edges.slice(0, 2) },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const reconverging = parallelGraph();
    expect(() =>
      buildWorkflowExecutable({
        graph: {
          ...reconverging,
          edges: [
            ...reconverging.edges,
            {
              id: 'left-right',
              source: { nodeId: 'left', port: 'out' },
              target: { nodeId: 'right', port: 'in' },
            },
          ],
        },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('accepts direct Parallel branches into paired Merge inputs', () => {
    const catalog = composeExecutableCatalog(
      nodeCatalog({ parallel: true, merge: true }),
    );
    expect(() =>
      buildWorkflowExecutable({
        graph: directPairedParallelGraph(),
        catalog,
      }),
    ).not.toThrow();
  });
  it('composes engine-owned policies and produces the pre-publication golden checksum', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });
    expect(compiled.envelope.graph.nodes.map(({ id }) => id)).toEqual([
      'manual',
      'set',
      'terminate',
    ]);
    expect(
      compiled.envelope.graph.nodes.map(
        ({ sideEffectClass }) => sideEffectClass,
      ),
    ).toEqual(['safe', 'safe', 'safe']);
    expect(compiled.checksum).toBe(
      'wf:sha256:bc624efc7e092d274f7655954b21da21501b8ac128fafb5095fdd91e7bb1e6d7',
    );
    expect(
      verifyWorkflowExecutable({
        ...compiled,
        catalog,
      }),
    ).toEqual(compiled);
  });
  it('is invariant to graph order and unrelated catalog additions', () => {
    const firstCatalog = composeExecutableCatalog(nodeCatalog());
    const laterCatalog = composeExecutableCatalog(
      nodeCatalog({ unrelated: true }),
    );
    const first = buildWorkflowExecutable({
      graph: graph(),
      catalog: firstCatalog,
    });
    const later = buildWorkflowExecutable({
      graph: graph(true),
      catalog: laterCatalog,
    });
    expect(later.checksum).toBe(first.checksum);
    const explicitFalse = structuredClone(graph());
    explicitFalse.nodes.forEach((node) =>
      Object.assign(node, { disabled: false }),
    );
    const explicit = buildWorkflowExecutable({
      graph: explicitFalse,
      catalog: firstCatalog,
    });
    expect(explicit.checksum).toBe(first.checksum);
    expect(first.envelope.graph.nodes.every(({ disabled }) => !disabled)).toBe(
      true,
    );
  });
  it('changes identity for a selected compatibility mutation', () => {
    const original = composeExecutableCatalog(nodeCatalog());
    const changed = composeExecutableCatalog(nodeCatalog({ mutateSet: true }));
    expect(
      buildWorkflowExecutable({ graph: graph(), catalog: changed }).checksum,
    ).not.toBe(
      buildWorkflowExecutable({ graph: graph(), catalog: original }).checksum,
    );
  });
});
