import { describe, expect, it } from 'vitest';

import type { WorkflowGraph, WorkflowNode } from '../../src/graph/contract.js';
import { workflowDefinitionPlacementIssues } from '../../src/graph/definition-placement.js';
import { EMPTY_DEFINITION_CATALOG } from '../../src/graph/identity.js';

const unavailable = { key: 'legacy.unavailable', version: 1 } as const;
const node = (id: string): WorkflowNode => ({
  id,
  definition: unavailable,
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
});
const graph = (...nodes: WorkflowNode[]): WorkflowGraph => ({
  settings: {},
  nodes,
  edges: [],
});

describe('definition placement', () => {
  it('retains one unavailable occurrence but rejects a newly placed one', () => {
    const previous = graph(node('old'));
    expect(
      workflowDefinitionPlacementIssues(
        previous,
        previous,
        EMPTY_DEFINITION_CATALOG,
      ),
    ).toEqual([]);
    expect(
      workflowDefinitionPlacementIssues(
        previous,
        graph(node('old'), node('new')),
        EMPTY_DEFINITION_CATALOG,
      ),
    ).toMatchObject([
      { code: 'definition_not_placeable', path: '$.nodes.new.definition' },
    ]);
  });

  it('checks nested placement and duplicate occurrences without treating a move as new', () => {
    const loop: WorkflowNode = {
      ...node('loop'),
      structured: {
        kind: 'for_each',
        maxIterations: 1,
        maxConcurrency: 1,
        body: {
          ...graph(node('old')),
          inputPorts: ['item'],
          outputPorts: ['result'],
        },
      },
    };
    const previous = graph(node('old'));
    const moved = graph(loop);
    expect(
      workflowDefinitionPlacementIssues(
        previous,
        moved,
        EMPTY_DEFINITION_CATALOG,
      ),
    ).toMatchObject([{ path: '$.nodes.loop.definition' }]);
    expect(
      workflowDefinitionPlacementIssues(
        previous,
        graph(node('old'), loop),
        EMPTY_DEFINITION_CATALOG,
      ),
    ).toMatchObject([
      { path: '$.nodes.old.definition' },
      { path: '$.nodes.loop.definition' },
      { path: '$.nodes.loop.structured.body.nodes.old.definition' },
    ]);
  });
});
