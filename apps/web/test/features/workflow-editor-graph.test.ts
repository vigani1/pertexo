import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { describe, expect, it } from 'vitest';
import {
  createEditorStore,
  EDIT_COALESCE_WINDOW_MS,
} from '@/features/workflow-editor/model/editor.store';
import { projectWorkflowGraph } from '@/features/workflow-editor/model/graph-adapter';
import {
  freePosition,
  moveWorkflowNodes,
  removeWorkflowElements,
  restoreWorkflowElements,
  updateWorkflowNode,
} from '@/features/workflow-editor/model/graph-commands';
import {
  adoptStepFrom,
  duplicateWorkflowNodes,
} from '@/features/workflow-editor/model/graph-copies';
import {
  edgeWeaveOrder,
  upstreamEdgeIds,
} from '@/features/workflow-editor/model/graph-order';
import {
  groupStepChoices,
  isStartTrigger,
  placeableDefinitions,
} from '@/features/workflow-editor/model/step-catalog';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

const etag = `"draft-v1.${'a'.repeat(43)}"`;

function node(id: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...extra,
  };
}

function edge(id: string, source: string, target: string, port = 'out') {
  return {
    id,
    source: { nodeId: source, port },
    target: { nodeId: target, port: 'in' },
  };
}

/** trigger → check → (true: finance, false: post) */
function branchingGraph(): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      node('trigger'),
      node('check'),
      node('finance'),
      node('post', {
        inputMappings: {
          amount: { kind: 'node_output', nodeId: 'check', path: '$.amount' },
        },
      }),
    ],
    edges: [
      edge('e1', 'trigger', 'check'),
      edge('e2', 'check', 'finance', 'true'),
      edge('e3', 'check', 'post', 'false'),
    ],
    settings: {},
  };
}

const definition = {
  schemaVersion: 1,
  definition: { key: 'slack.send_message', version: 1 },
  family: 'action',
  configVersion: 1,
  configSchema: {},
  inputSchema: {},
  outputSchema: {},
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: ['slack_bot_token'],
  retryClass: 'unsafe',
  resourceClass: 'io',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
} satisfies NodeDefinitionCatalogItem;

describe('editor graph commands', () => {
  it('removes connections alone and restores removed steps with their connections', () => {
    const graph = branchingGraph();
    const edgeOnly = removeWorkflowElements(graph, {
      nodeIds: [],
      edgeIds: ['e2'],
    });
    expect(edgeOnly.graph.nodes).toBe(graph.nodes);
    expect(edgeOnly.graph.edges.map((item) => item.id)).toEqual(['e1', 'e3']);
    expect(edgeOnly.removed).toEqual({
      nodes: [],
      edges: [graph.edges[1]],
      scopes: { e2: [] },
    });

    const stepRemoved = removeWorkflowElements(graph, {
      nodeIds: ['check'],
      edgeIds: [],
    });
    expect(stepRemoved.graph.edges).toEqual([]);
    expect(stepRemoved.removed.edges.map((item) => item.id)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    const restored = restoreWorkflowElements(
      stepRemoved.graph,
      stepRemoved.removed,
    );
    expect(restored.nodes.map((item) => item.id).sort()).toEqual([
      'check',
      'finance',
      'post',
      'trigger',
    ]);
    expect(restored.edges).toHaveLength(3);
    expect(restoreWorkflowElements(restored, stepRemoved.removed)).toBe(
      restored,
    );
    expect(
      removeWorkflowElements(graph, { nodeIds: ['nope'], edgeIds: [] }).graph,
    ).toBe(graph);
  });

  it('duplicates steps with fresh IDs, internal connections and remapped outputs', () => {
    let counter = 0;
    const result = duplicateWorkflowNodes(
      branchingGraph(),
      ['check', 'post'],
      () => {
        counter += 1;
        return `copy-${String(counter)}`;
      },
    );
    expect(result.nodeIds).toEqual(['copy-1', 'copy-2']);
    const copies = result.graph.nodes.slice(-2);
    expect(copies.map((item) => item.position)).toEqual([
      { x: 48, y: 48 },
      { x: 48, y: 48 },
    ]);
    expect(copies[1]?.inputMappings).toEqual({
      amount: { kind: 'node_output', nodeId: 'copy-1', path: '$.amount' },
    });
    expect(result.graph.edges.at(-1)).toEqual({
      id: 'copy-3',
      source: { nodeId: 'copy-1', port: 'false' },
      target: { nodeId: 'copy-2', port: 'in' },
    });
  });

  it('re-applies one step from a kept copy with its connections, or removes it', () => {
    const mine = branchingGraph();
    const theirs: WorkflowGraphContract = {
      ...mine,
      nodes: mine.nodes.filter((item) => item.id !== 'post'),
      edges: mine.edges.filter((item) => item.id !== 'e3'),
    };
    const reapplied = adoptStepFrom(theirs, mine, 'post');
    expect(reapplied.nodes.map((item) => item.id)).toContain('post');
    expect(reapplied.edges.map((item) => item.id)).toContain('e3');
    expect(
      adoptStepFrom(mine, theirs, 'post').nodes.map((item) => item.id),
    ).not.toContain('post');
  });

  it('moves several steps in one change and skips unchanged positions', () => {
    const graph = branchingGraph();
    expect(moveWorkflowNodes(graph, new Map([['check', { x: 0, y: 0 }]]))).toBe(
      graph,
    );
    const moved = moveWorkflowNodes(
      graph,
      new Map([
        ['check', { x: 10, y: 5 }],
        ['post', { x: 40, y: 5 }],
      ]),
    );
    expect(moved.nodes.map((item) => item.position.x)).toEqual([0, 10, 0, 40]);
    expect(freePosition(graph, { x: 0, y: 0 })).toEqual({ x: 64, y: 64 });
    expect(updateWorkflowNode(graph, 'check', { disabled: false })).toBe(graph);
    expect(
      updateWorkflowNode(graph, 'check', { disabled: true }).nodes[1]?.disabled,
    ).toBe(true);
  });

  it('orders a publish weave and a test path by execution', () => {
    const graph = branchingGraph();
    expect([...edgeWeaveOrder(graph)]).toEqual([
      ['e1', 0],
      ['e2', 1],
      ['e3', 1],
    ]);
    expect([...upstreamEdgeIds(graph, 'post')].sort()).toEqual(['e1', 'e3']);
    expect(upstreamEdgeIds(graph, 'trigger').size).toBe(0);
  });

  it('marks issues, missing connections and disabled steps on the canvas projection', () => {
    const graph: WorkflowGraphContract = {
      ...branchingGraph(),
      nodes: [
        node('trigger'),
        node('slack', {
          definition: { key: 'slack.send_message', version: 1 },
          disabled: true,
        }),
      ],
      edges: [edge('e1', 'trigger', 'slack')],
    };
    const projection = projectWorkflowGraph(graph, [definition], {
      issuesByNode: new Map([['slack', 2]]),
      flowingEdgeIds: new Set(['e1']),
      weaveOrder: null,
      selectedNodeIds: ['slack'],
      selectedEdgeIds: [],
      dragPositions: new Map([['trigger', { x: 5, y: 6 }]]),
      bodyIssues: new Map(),
    });
    expect(projection.nodes[0]?.position).toEqual({ x: 5, y: 6 });
    expect(projection.nodes[1]?.selected).toBe(true);
    expect(projection.nodes[1]?.data).toMatchObject({
      issueCount: 2,
      missingConnections: 1,
      disabled: true,
      family: 'action',
    });
    expect(projection.edges[0]?.data).toMatchObject({
      flowing: true,
      intoIssue: true,
      sourceLabel: 'Set fields',
      targetLabel: 'Send Slack message',
    });
  });
});

describe('add-step choices', () => {
  it('groups placeable steps by human family names and hides unavailable ones', () => {
    const groups = groupStepChoices(
      [
        definition,
        {
          ...definition,
          definition: { key: 'core.wait', version: 1 },
          family: 'logic',
          available: false,
        },
      ],
      '',
    );
    expect(groups.map((group) => group.title)).toEqual(['Do something']);
    expect(groupStepChoices([definition], 'slack')[0]?.choices).toHaveLength(1);
    expect(groupStepChoices([definition], 'channel post')).toEqual([]);
  });

  it('offers one entry per step type, at its highest publishable version', () => {
    const version = (
      value: number,
      extra: Partial<NodeDefinitionCatalogItem> = {},
    ) =>
      ({
        ...definition,
        definition: { key: 'core.merge', version: value },
        family: 'logic',
        ...extra,
      }) satisfies NodeDefinitionCatalogItem;
    const groups = groupStepChoices(
      [
        version(1),
        version(3, { publishable: false }),
        version(2),
        version(4, { available: false }),
        definition,
      ],
      '',
    );
    expect(
      groups.flatMap((group) => group.choices.map((choice) => choice.identity)),
    ).toEqual(['slack.send_message@1', 'core.merge@2']);
    expect(
      placeableDefinitions([
        version(1, { publishable: false }),
        version(2),
      ]).map((item) => item.definition.version),
    ).toEqual([2]);
    expect(
      placeableDefinitions([
        version(1, { publishable: false }),
        version(2, { publishable: false }),
      ]).map((item) => item.definition.version),
    ).toEqual([2]);
  });

  it('folds Switch, Parallel and Merge into one row while browsing, never while searching', () => {
    const logic = (key: string) =>
      ({
        ...definition,
        definition: { key, version: 1 },
        family: 'logic',
      }) satisfies NodeDefinitionCatalogItem;
    const catalog = [
      logic('core.condition'),
      logic('core.merge'),
      logic('core.parallel'),
      logic('core.switch'),
      logic('core.wait'),
    ];
    const [browsing] = groupStepChoices(catalog, '');
    expect(
      browsing?.entries.map((entry) =>
        entry.kind === 'step' ? entry.choice.step.name : entry.bundle.name,
      ),
    ).toEqual(['Condition', 'Switch · Parallel · Merge', 'Wait']);
    const bundle = browsing?.entries.find((entry) => entry.kind === 'bundle');
    expect(
      bundle?.kind === 'bundle'
        ? bundle.bundle.choices.map((choice) => choice.identity)
        : [],
    ).toEqual(['core.switch@1', 'core.parallel@1', 'core.merge@1']);
    expect(browsing?.choices).toHaveLength(5);

    const [searching] = groupStepChoices(catalog, 'merge');
    expect(searching?.entries).toEqual([
      { kind: 'step', choice: searching?.choices[0] },
    ]);
    expect(searching?.choices[0]?.step.name).toBe('Merge');

    const [alone] = groupStepChoices([logic('core.switch')], '');
    expect(alone?.entries.map((entry) => entry.kind)).toEqual(['step']);
  });

  it('starts drafts only with triggers that can be placed and published', () => {
    const trigger = {
      ...definition,
      definition: { key: 'core.manual', version: 1 },
      family: 'trigger',
    } satisfies NodeDefinitionCatalogItem;
    expect(isStartTrigger(trigger)).toBe(true);
    expect(isStartTrigger({ ...trigger, publishable: false })).toBe(false);
    expect(isStartTrigger({ ...trigger, available: false })).toBe(false);
    expect(isStartTrigger(definition)).toBe(false);
  });
});

describe('editor history', () => {
  it('coalesces live edits of one field into one undo step within the window', () => {
    let now = 1_000;
    const start: WorkflowGraphContract = {
      schemaVersion: 1,
      nodes: [node('a')],
      edges: [],
      settings: {},
    };
    const store = createEditorStore(
      { graph: start, etag, revision: 1 },
      { now: () => now },
    );
    const label = (value: string) =>
      updateWorkflowNode(store.getState().graph, 'a', { label: value });
    store.getState().transact(label('N'), { coalesceKey: 'a:label' });
    now += 200;
    store.getState().transact(label('Na'), { coalesceKey: 'a:label' });
    now += 200;
    store.getState().transact(label('Name'), { coalesceKey: 'a:label' });
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().generation).toBe(3);

    now += EDIT_COALESCE_WINDOW_MS + 1;
    store.getState().transact(label('Named'), { coalesceKey: 'a:label' });
    store
      .getState()
      .transact(
        updateWorkflowNode(store.getState().graph, 'a', { config: { x: 1 } }),
        { coalesceKey: 'a:config:x' },
      );
    expect(store.getState().history.past).toHaveLength(3);

    store.getState().undo();
    store.getState().undo();
    expect(store.getState().graph.nodes[0]?.label).toBe('Name');
    store.getState().undo();
    expect(store.getState().graph).toBe(start);
    expect(store.getState().saveStatus).toBe('dirty');
  });

  it('forgets inspector scratch when the inspected step goes away', () => {
    const start: WorkflowGraphContract = {
      schemaVersion: 1,
      nodes: [node('a'), node('b')],
      edges: [],
      settings: {},
    };
    const store = createEditorStore({ graph: start, etag, revision: 1 });
    store.getState().selectNode('a');
    store.getState().setInspectorScratch(true);
    store.getState().selectNodes(['a']);
    expect(store.getState().inspectorScratch).toBe(true);
    store.getState().transact(
      removeWorkflowElements(store.getState().graph, {
        nodeIds: ['a'],
        edgeIds: [],
      }).graph,
    );
    expect(store.getState().selectedNodeId).toBeNull();
    expect(store.getState().inspectorScratch).toBe(false);
  });
});
