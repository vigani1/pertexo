import { describe, expect, it } from 'vitest';
import {
  stepSampleBindings,
  stepSampleIdentity,
} from '../../src/samples/identity.js';
import type { WorkflowNode } from '../../src/graph/contract.js';

const node: WorkflowNode = {
  id: 'step',
  definition: { key: 'core.set', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: { a: 1, b: 2 },
  inputMappings: {},
  connectionRefs: {},
};
describe('pinned sample setup identity', () => {
  it('preserves pins through cosmetic edits and canonical key ordering', () => {
    expect(
      stepSampleIdentity({
        ...node,
        label: 'Another name',
        position: { x: 500, y: 30 },
        config: { b: 2, a: 1 },
        disabled: false,
      }),
    ).toBe(stepSampleIdentity(node));
  });
  it.each<Partial<WorkflowNode>>([
    { definition: { key: 'core.other', version: 1 } },
    { definition: { key: 'core.set', version: 2 } },
    { configVersion: 2 },
    { config: { a: 2 } },
    { inputMappings: { value: { kind: 'run_input', path: 'amount' } } },
    { connectionRefs: { credential: '00000000-0000-4000-8000-000000000001' } },
    { disabled: true },
  ])('invalidates a changed behavior field: %o', (change) => {
    expect(stepSampleIdentity({ ...node, ...change })).not.toBe(
      stepSampleIdentity(node),
    );
  });
  it('binds loop limits and body settings while tracking each child step separately', () => {
    const loop: WorkflowNode = {
      ...node,
      id: 'loop',
      definition: { key: 'core.for_each', version: 1 },
      structured: {
        kind: 'for_each',
        maxIterations: 20,
        maxConcurrency: 1,
        body: {
          nodes: [node],
          edges: [],
          settings: {},
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
    if (loop.structured === undefined) throw new Error('Loop fixture missing');
    const before = stepSampleIdentity(loop);
    expect(
      stepSampleIdentity({
        ...loop,
        structured: { ...loop.structured, maxIterations: 21 },
      }),
    ).not.toBe(before);
    expect(
      stepSampleIdentity({
        ...loop,
        structured: { ...loop.structured, maxConcurrency: 2 },
      }),
    ).not.toBe(before);
    expect(
      stepSampleIdentity({
        ...loop,
        structured: {
          ...loop.structured,
          body: { ...loop.structured.body, outputPorts: ['changed'] },
        },
      }),
    ).not.toBe(before);
    const bindings = stepSampleBindings({
      nodes: [loop],
      edges: [],
      settings: {},
    });
    expect(bindings.get('step')).toBe(stepSampleIdentity(node));
    expect(bindings.get('loop')).toBe(before);
  });
  it('ignores workflow links and refuses ambiguous step IDs', () => {
    const graph = { nodes: [node], edges: [], settings: {} };
    expect(stepSampleBindings(graph).get('step')).toBe(
      stepSampleIdentity(node),
    );
    expect(
      stepSampleBindings({
        ...graph,
        nodes: [node, { ...node, config: { changed: true } }],
      }).has('step'),
    ).toBe(false);
  });
});
