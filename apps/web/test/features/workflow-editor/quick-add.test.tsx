import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { Position, type FinalConnectionState } from '@xyflow/react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';
import {
  addStepAfter,
  positionAfter,
} from '@/features/workflow-editor/model/graph/commands';
import {
  followingSteps,
  gestureEndPoint,
  openOutputPort,
  portDropSource,
} from '@/features/workflow-editor/model/quick-add';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  addStepButton,
  editorHandlers,
  editorPath,
  etagA,
  findCanvas,
  graphWithMappingNodes,
  manualDefinition,
  mappingDefinition,
  pressSave,
} from '../../support/fixtures/workflow-editor';

import {
  forEachDefinition,
  orderLoopGraph,
} from '../../support/fixtures/for-each';

const conditionDefinition = {
  ...mappingDefinition,
  definition: { key: 'core.condition', version: 1 },
  family: 'logic',
  ports: { inputs: ['in'], outputs: ['true', 'false'] },
} satisfies NodeDefinitionCatalogItem;
const mergeDefinition = {
  ...mappingDefinition,
  definition: { key: 'core.merge', version: 1 },
  family: 'logic',
  ports: { inputs: ['branch-01', 'branch-02'], outputs: ['out'] },
} satisfies NodeDefinitionCatalogItem;

/** manual → target, with target's `out` still free. */
const graph: WorkflowGraphContract = graphWithMappingNodes();

function dropState(
  fromHandle: Readonly<{ id: string | null; type: 'source' | 'target' }>,
  toNode: 'none' | 'step' = 'none',
): FinalConnectionState {
  return {
    isValid: toNode === 'step' ? true : null,
    from: { x: 0, y: 0 },
    fromHandle: {
      ...fromHandle,
      nodeId: 'target',
      x: 0,
      y: 0,
      position: Position.Right,
      width: 8,
      height: 8,
    },
    fromPosition: Position.Right,
    fromNode: {} as never,
    to: { x: 0, y: 0 },
    toHandle: null,
    toPosition: null,
    toNode: toNode === 'step' ? ({} as never) : null,
    pointer: { x: 0, y: 0 },
  };
}

describe('quick add graph commands', () => {
  it('adds a step and its connection from the chosen output as one change', () => {
    const next = addStepAfter({
      graph,
      definition: mappingDefinition,
      position: { x: 600, y: 80 },
      from: { nodeId: 'target', port: 'out' },
      ids: { nodeId: 'added', edgeId: 'target-added' },
    });
    expect(next?.nodes.at(-1)).toMatchObject({
      id: 'added',
      definition: { key: 'core.set', version: 1 },
      position: { x: 600, y: 80 },
    });
    expect(next?.edges.at(-1)).toEqual({
      id: 'target-added',
      source: { nodeId: 'target', port: 'out' },
      target: { nodeId: 'added', port: 'in' },
    });

    const store = createEditorStore({ graph, etag: etagA, revision: 1 });
    if (next === null) throw new Error('expected a graph');
    store.getState().transact(next);
    store.getState().undo();
    expect(store.getState().graph).toBe(graph);
  });

  it('matches a same-named input, and refuses steps it can’t connect', () => {
    const fromBranch = addStepAfter({
      graph,
      definition: mergeDefinition,
      position: { x: 0, y: 0 },
      from: { nodeId: 'target', port: 'branch-02' },
      ids: { nodeId: 'merge', edgeId: 'edge' },
    });
    expect(fromBranch?.edges.at(-1)?.target).toEqual({
      nodeId: 'merge',
      port: 'branch-02',
    });
    expect(
      addStepAfter({
        graph,
        definition: manualDefinition,
        position: { x: 0, y: 0 },
        from: {
          nodeId: 'target',
          port: 'out',
        },
      }),
    ).toBeNull();
    expect(
      addStepAfter({
        graph,
        definition: mappingDefinition,
        position: { x: 0, y: 0 },
        from: {
          nodeId: 'missing',
          port: 'out',
        },
      }),
    ).toBeNull();
    expect(followingSteps([manualDefinition, mappingDefinition])).toEqual([
      mappingDefinition,
    ]);
  });

  it('continues from the first free output, one card to the right', () => {
    const branching: WorkflowGraphContract = {
      ...graph,
      edges: [
        {
          id: 'taken',
          source: { nodeId: 'check', port: 'true' },
          target: { nodeId: 'target', port: 'in' },
        },
      ],
    };
    expect(openOutputPort(branching, 'check', ['true', 'false'])).toBe('false');
    expect(openOutputPort(graph, 'manual', ['out'])).toBe('out');
    expect(openOutputPort(graph, 'target', [])).toBeUndefined();
    expect(positionAfter({ position: { x: 100, y: 40 } })).toEqual({
      x: 388,
      y: 40,
    });
  });
});

describe('quick add port drop', () => {
  it('opens only for an output dropped on empty canvas', () => {
    expect(
      portDropSource({
        state: dropState({ id: 'out', type: 'source' }),
        endedOverStep: false,
      }),
    ).toEqual({ nodeId: 'target', port: 'out' });
    expect(
      portDropSource({
        state: dropState({ id: 'out', type: 'source' }, 'step'),
        endedOverStep: false,
      }),
    ).toBeNull();
    expect(
      portDropSource({
        state: dropState({ id: 'out', type: 'source' }),
        endedOverStep: true,
      }),
    ).toBeNull();
    expect(
      portDropSource({
        state: dropState({ id: 'in', type: 'target' }),
        endedOverStep: false,
      }),
    ).toBeNull();
    expect(
      portDropSource({
        state: dropState({ id: null, type: 'source' }),
        endedOverStep: false,
      }),
    ).toBeNull();
  });

  it('reads where a mouse or touch gesture ended', () => {
    expect(
      gestureEndPoint(new MouseEvent('mouseup', { clientX: 12, clientY: 34 })),
    ).toEqual({ x: 12, y: 34 });
    const touch = {
      changedTouches: [{ clientX: 5, clientY: 6 }],
    } as unknown as TouchEvent;
    expect(gestureEndPoint(touch)).toEqual({ x: 5, y: 6 });
  });
});

describe('quick add in the editor', { timeout: 30_000 }, () => {
  it('adds a connected step after the selected one from its ⋯ menu, undoable as one step', async () => {
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        { graph, definitions: [manualDefinition, mappingDefinition] },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    const canvas = await findCanvas();
    fireEvent.click(canvas.getByText('Target'));
    await event.click(screen.getByRole('button', { name: 'Step actions' }));
    await event.click(
      await screen.findByRole('menuitem', { name: 'Add step after' }),
    );
    const lens = await screen.findByRole('dialog', {
      name: 'Add a step after “Target”',
    });
    const search = within(lens).getByRole('searchbox', {
      name: 'Search steps',
    });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    expect(
      within(lens).queryByRole('button', { name: /Manual start/u }),
    ).toBeNull();
    await event.type(search, 'set');
    await event.click(
      within(lens).getByRole('button', { name: /Set fields/u }),
    );
    expect(
      screen.queryByRole('dialog', { name: /Add a step after/u }),
    ).toBeNull();
    // The new, unlabelled step's card is titled by its type.
    expect(
      canvas.getByText('Set fields', { selector: 'h2' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Label')).toHaveAttribute(
      'placeholder',
      'Set fields',
    );

    pressSave();
    await waitFor(() => {
      expect(savedGraph?.nodes).toHaveLength(3);
    });
    const added = savedGraph?.nodes[2];
    expect(savedGraph?.edges.at(-1)).toMatchObject({
      source: { nodeId: 'target', port: 'out' },
      target: { nodeId: added?.id, port: 'in' },
    });
    expect(added?.position.x).toBeGreaterThan(340);

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => {
      expect(canvas.queryByText('Set fields', { selector: 'h2' })).toBeNull();
    });
    pressSave();
    await waitFor(() => {
      expect(savedGraph?.edges).toHaveLength(1);
    });
    expect(savedGraph?.nodes).toHaveLength(2);
  });

  it('lets people pick which output a new step follows', async () => {
    const branching: WorkflowGraphContract = {
      nodes: [
        {
          ...graph.nodes[1],
          id: 'check',
          definition: { key: 'core.condition', version: 1 },
          label: 'Over 5,000?',
        } as WorkflowGraphContract['nodes'][number],
      ],
      edges: [],
      settings: {},
    };
    let savedGraph: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          savedGraph = body.graph;
        },
        {
          graph: branching,
          definitions: [conditionDefinition, mappingDefinition],
        },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Over 5,000?'));
    const menu = screen.getByRole('button', { name: 'Step actions' });
    await event.click(menu);
    await event.click(
      await screen.findByRole('menuitem', { name: 'Add step after' }),
    );
    await screen.findByRole('dialog', { name: /Add a step after/u });
    await event.keyboard('{Escape}');
    await waitFor(() => {
      expect(menu).toHaveFocus();
    });
    expect(
      screen.queryByRole('dialog', { name: /Add a step after/u }),
    ).toBeNull();

    await event.click(menu);
    await event.click(
      await screen.findByRole('menuitem', { name: 'Add step after' }),
    );
    const lens = await screen.findByRole('dialog', {
      name: 'Add a step after “Over 5,000?”',
    });
    await event.click(within(lens).getByLabelText('Link from'));
    await event.click(await screen.findByRole('option', { name: 'false' }));
    await event.click(
      within(lens).getByRole('button', { name: /Set fields/u }),
    );
    pressSave();
    await waitFor(() => {
      expect(savedGraph?.edges[0]?.source).toEqual({
        nodeId: 'check',
        port: 'false',
      });
    });
  });
});

describe('palette placement after selection', { timeout: 30_000 }, () => {
  it('links to the selected step on its right and undoes both together', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        {
          graph,
          definitions: [manualDefinition, mappingDefinition],
        },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    const canvas = await findCanvas();
    fireEvent.click(canvas.getByText('Target'));
    await event.click(addStepButton(/Set fields/u));
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes).toHaveLength(3);
    });
    const added = saved?.nodes.at(-1);
    expect(added?.position.x).toBeGreaterThan(340 + 224);
    expect(saved?.edges.at(-1)).toMatchObject({
      source: { nodeId: 'target', port: 'out' },
      target: { nodeId: added?.id, port: 'in' },
    });
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes).toHaveLength(2);
    });
    expect(saved?.edges).toEqual(graph.edges);
  });

  it('follows the displayed body position and keeps the new step inside the loop', async () => {
    const loopGraph = orderLoopGraph();
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        {
          graph: loopGraph,
          definitions: [forEachDefinition, mappingDefinition],
        },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Reserve item'));
    await event.click(addStepButton(/Set fields/u));
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes[1]?.structured?.body.nodes).toHaveLength(3);
    });
    const body = saved?.nodes[1]?.structured?.body;
    const added = body?.nodes.at(-1);
    expect(saved?.nodes).toHaveLength(3);
    expect(saved?.edges).toEqual(loopGraph.edges);
    expect(added?.position.x).toBeGreaterThan(288 + 224);
    expect(body?.edges.at(-1)).toMatchObject({
      source: { nodeId: 'reserve', port: 'out' },
      target: { nodeId: added?.id, port: 'in' },
    });
    expect(saved?.nodes[2]?.position.x).toBeGreaterThan(
      loopGraph.nodes[2]?.position.x ?? 0,
    );
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes[1]?.structured?.body.nodes).toHaveLength(2);
    });
    expect(saved).toEqual(loopGraph);
  });

  it('uses only configured outputs and prefers a free output', async () => {
    const parallel = {
      ...conditionDefinition,
      definition: { key: 'core.parallel', version: 1 },
      ports: {
        inputs: ['in'],
        outputs: ['branch-01', 'branch-02', 'branch-03', 'branch-04'],
      },
      configSchema: {
        type: 'object',
        properties: {
          branches: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                id: {
                  enum: ['branch-01', 'branch-02', 'branch-03', 'branch-04'],
                },
              },
            },
          },
        },
      },
    } satisfies NodeDefinitionCatalogItem;
    const [source, target] = graph.nodes;
    if (source === undefined || target === undefined)
      throw new Error('Fixture steps missing');
    const branching: WorkflowGraphContract = {
      ...graph,
      nodes: [
        {
          ...source,
          id: 'branches',
          label: 'Branches',
          definition: parallel.definition,
          config: { branches: [{ id: 'branch-03' }, { id: 'branch-04' }] },
        },
        target,
      ],
      edges: [
        {
          id: 'taken',
          source: { nodeId: 'branches', port: 'branch-03' },
          target: { nodeId: 'target', port: 'in' },
        },
      ],
    };
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        { graph: branching, definitions: [parallel, mappingDefinition] },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Branches'));
    await event.click(addStepButton(/Set fields/u));
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes).toHaveLength(3);
    });
    expect(saved?.edges.at(-1)?.source).toEqual({
      nodeId: 'branches',
      port: 'branch-04',
    });
  });

  it('adds an inputless trigger without a link even when a step is selected', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        { graph, definitions: [manualDefinition, mappingDefinition] },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Target'));
    await event.click(addStepButton(/Manual start/u));
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes).toHaveLength(3);
    });
    expect(saved?.edges).toEqual(graph.edges);
    expect(saved?.nodes.at(-1)?.definition).toEqual(
      manualDefinition.definition,
    );
  });
});
