import { describe, expect, it } from 'vitest';

import {
  workflowControlOutputKind,
  workflowControlOutputNodeIds,
} from '../../src/graph/control-output-selection.js';

describe('immutable executable control-output selection', () => {
  it('selects current control identities across structured bodies, not output-shaped Set nodes', () => {
    expect(
      workflowControlOutputNodeIds({
        graph: {
          nodes: [
            {
              id: 'condition',
              definition: { key: 'core.condition', version: 1 },
            },
            { id: 'switch', definition: { key: 'core.switch', version: 1 } },
            {
              id: 'parallel',
              definition: { key: 'core.parallel', version: 1 },
            },
            {
              id: 'set',
              definition: { key: 'core.set', version: 1 },
              config: { selectedPort: 'true' },
            },
            {
              id: 'foreach',
              definition: { key: 'core.foreach', version: 1 },
              structured: {
                body: {
                  nodes: [
                    {
                      id: 'nested-condition',
                      definition: { key: 'core.condition', version: 1 },
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
    ).toEqual(
      new Set([
        'condition',
        'switch',
        'parallel',
        'foreach',
        'nested-condition',
      ]),
    );
    expect(
      workflowControlOutputKind({ key: 'core.condition', version: 2 }),
    ).toBeUndefined();
  });

  it('bounds metadata traversal without inspecting output values', () => {
    expect(() =>
      workflowControlOutputNodeIds({
        graph: {
          nodes: Array.from({ length: 10_001 }, (_, index) => ({
            id: `node-${String(index)}`,
            definition: { key: 'core.set', version: 1 },
          })),
        },
      }),
    ).toThrow(RangeError);
  });

  it.each([
    null,
    {},
    { graph: {} },
    { graph: { nodes: [{ id: 'condition' }] } },
    {
      graph: {
        nodes: [
          {
            id: 'loop',
            definition: { key: 'core.foreach', version: 1 },
            structured: {},
          },
        ],
      },
    },
  ])(
    'fails closed for invalid or incomplete executable metadata %j',
    (value) => {
      expect(() => workflowControlOutputNodeIds(value)).toThrow(TypeError);
    },
  );
});
