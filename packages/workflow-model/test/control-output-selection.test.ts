import { describe, expect, it } from 'vitest';

import {
  workflowCallNodeIdsV3,
  workflowControlOutputKind,
  workflowControlOutputNodeIdsV2,
  workflowControlOutputNodeIdsV3,
} from '../src/graph/control-output-selection.js';

describe('immutable executable control-output selection', () => {
  const nativeGraph = {
    nodes: [
      { id: 'call', definition: { key: 'core.workflow_call', version: 1 } },
      {
        id: 'future-call',
        definition: { key: 'core.workflow_call', version: 2 },
      },
      {
        id: 'loop',
        definition: { key: 'core.foreach', version: 1 },
        structured: {
          body: {
            nodes: [
              {
                id: 'nested-call',
                definition: { key: 'core.workflow_call', version: 1 },
              },
              { id: 'set', definition: { key: 'core.set', version: 1 } },
            ],
          },
        },
      },
    ],
  };

  it('selects actual V3 Call identities alongside controls, including nested calls', () => {
    const executable = { schemaVersion: 3, graph: nativeGraph };
    expect(workflowControlOutputNodeIdsV3(executable)).toEqual(
      new Set(['call', 'loop', 'nested-call']),
    );
    expect(workflowCallNodeIdsV3(executable)).toEqual(
      new Set(['call', 'nested-call']),
    );
  });

  it('does not upgrade retained V2 Call-shaped identities or accept V2 as native', () => {
    const retained = { schemaVersion: 2, graph: nativeGraph };
    expect(workflowControlOutputNodeIdsV2(retained)).toEqual(new Set(['loop']));
    expect(() => workflowCallNodeIdsV3(retained)).toThrow(TypeError);
    expect(() =>
      workflowControlOutputNodeIdsV2({ schemaVersion: 3, graph: nativeGraph }),
    ).toThrow(TypeError);
  });

  it.each([workflowControlOutputNodeIdsV3, workflowCallNodeIdsV3])(
    'shares global duplicate and node-count validation for native selection',
    (select) => {
      expect(() =>
        select({
          schemaVersion: 3,
          graph: {
            nodes: [
              ...nativeGraph.nodes,
              {
                id: 'nested-call',
                definition: { key: 'core.set', version: 1 },
              },
            ],
          },
        }),
      ).toThrow(TypeError);
      expect(() =>
        select({
          schemaVersion: 3,
          graph: {
            nodes: Array.from({ length: 10_001 }, (_, index) => ({
              id: `node-${String(index)}`,
              definition: { key: 'core.set', version: 1 },
            })),
          },
        }),
      ).toThrow(RangeError);
    },
  );

  it('selects current control identities across structured bodies, not output-shaped Set nodes', () => {
    expect(
      workflowControlOutputNodeIdsV2({
        schemaVersion: 2,
        graph: {
          nodes: [
            {
              id: 'condition',
              definition: { key: 'core.condition', version: 1 },
            },
            { id: 'switch', definition: { key: 'core.switch', version: 1 } },
            {
              id: 'parallel',
              definition: { key: 'core.parallel', version: 3 },
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
      workflowControlOutputNodeIdsV2({
        schemaVersion: 2,
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
    { schemaVersion: 1, graph: { nodes: [] } },
    { schemaVersion: 2 },
    { schemaVersion: 2, graph: {} },
    { schemaVersion: 2, graph: { nodes: [{ id: 'condition' }] } },
    {
      schemaVersion: 2,
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
  ])('fails closed for invalid or incomplete V2 metadata %j', (value) => {
    expect(() => workflowControlOutputNodeIdsV2(value)).toThrow(TypeError);
  });
});
