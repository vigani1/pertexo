import { expect, it } from 'vitest';
import { workflowGraphSchema } from '@pertexo/contracts';
import {
  linkWorkflowNodes,
  canStartWorkflowLink,
} from '@/features/workflow-editor/model/graph/workflow-graph-commands';
import { shownPorts } from '@/features/workflow-editor/model/step-card';
import { browserDefinitions } from '../../../support/fixtures/node-catalog';

it('keeps an orphan Switch output visible for repair and refuses new links from it', () => {
  const graph = workflowGraphSchema.parse({
    nodes: [
      {
        id: 'switch',
        definition: { key: 'core.switch', version: 1 },
        configVersion: 1,
        position: { x: 0, y: 0 },
        config: { cases: [{ id: 'case-01', equals: 'ready' }] },
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'target',
        definition: { key: 'core.set', version: 1 },
        configVersion: 1,
        position: { x: 300, y: 0 },
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'old-target',
        definition: { key: 'core.set', version: 1 },
        configVersion: 1,
        position: { x: 300, y: 200 },
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'orphan',
        source: { nodeId: 'switch', port: 'case-02' },
        target: { nodeId: 'old-target', port: 'in' },
      },
    ],
    settings: {},
  });
  const definitions = browserDefinitions();
  const source = graph.nodes[0];
  if (source === undefined) throw new Error('Expected the Switch');
  expect(
    shownPorts(
      source,
      definitions.find(
        (definition) => definition.definition.key === 'core.switch',
      ),
      graph,
      'outputs',
    ),
  ).toContain('case-02');
  expect(
    canStartWorkflowLink(
      graph,
      { nodeId: 'switch', port: 'case-02' },
      definitions,
    ),
  ).toBe(false);
  expect(
    linkWorkflowNodes(
      graph,
      {
        source: 'switch',
        sourceHandle: 'case-02',
        target: 'target',
        targetHandle: 'in',
      },
      definitions,
    ),
  ).toBeNull();
  const connected = linkWorkflowNodes(
    graph,
    {
      source: 'switch',
      sourceHandle: 'case-01',
      target: 'target',
      targetHandle: 'in',
    },
    definitions,
    'valid',
  );
  expect(connected?.edges).toContainEqual({
    id: 'valid',
    source: { nodeId: 'switch', port: 'case-01' },
    target: { nodeId: 'target', port: 'in' },
  });
});
