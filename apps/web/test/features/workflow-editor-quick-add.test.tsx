import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { FinalConnectionState } from '@xyflow/react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createEditorStore } from '@/features/workflow-editor/model/editor.store';
import {
  addStepAfter,
  positionAfter,
} from '@/features/workflow-editor/model/graph-commands';
import {
  followingSteps,
  gestureEndPoint,
  openOutputPort,
  portDropSource,
} from '@/features/workflow-editor/model/quick-add';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  editorHandlers,
  editorPath,
  etagA,
  findCanvas,
  graphWithMappingNodes,
  manualDefinition,
  mappingDefinition,
  pressSave,
} from '../support/workflow-editor-fixtures';

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
      position: 'right',
      width: 8,
      height: 8,
    },
    fromPosition: 'right',
    fromNode: {} as never,
    to: { x: 0, y: 0 },
    toHandle: null,
    toPosition: null,
    toNode: toNode === 'step' ? ({} as never) : null,
    pointer: { x: 0, y: 0 },
  } as FinalConnectionState;
}

describe('quick add graph commands', () => {
  it('adds a step and its connection from the chosen output as one change', () => {
    const next = addStepAfter(
      graph,
      mappingDefinition,
      { x: 600, y: 80 },
      { nodeId: 'target', port: 'out' },
      { nodeId: 'added', edgeId: 'target-added' },
    );
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
    const fromBranch = addStepAfter(
      graph,
      mergeDefinition,
      { x: 0, y: 0 },
      { nodeId: 'target', port: 'branch-02' },
      { nodeId: 'merge', edgeId: 'edge' },
    );
    expect(fromBranch?.edges.at(-1)?.target).toEqual({
      nodeId: 'merge',
      port: 'branch-02',
    });
    expect(
      addStepAfter(
        graph,
        manualDefinition,
        { x: 0, y: 0 },
        {
          nodeId: 'target',
          port: 'out',
        },
      ),
    ).toBeNull();
    expect(
      addStepAfter(
        graph,
        mappingDefinition,
        { x: 0, y: 0 },
        {
          nodeId: 'missing',
          port: 'out',
        },
      ),
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
      portDropSource(dropState({ id: 'out', type: 'source' }), false),
    ).toEqual({ nodeId: 'target', port: 'out' });
    expect(
      portDropSource(dropState({ id: 'out', type: 'source' }, 'step'), false),
    ).toBeNull();
    expect(
      portDropSource(dropState({ id: 'out', type: 'source' }), true),
    ).toBeNull();
    expect(
      portDropSource(dropState({ id: 'in', type: 'target' }), false),
    ).toBeNull();
    expect(
      portDropSource(dropState({ id: null, type: 'source' }), false),
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
      schemaVersion: 1,
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
    await event.click(within(lens).getByLabelText('Connect from'));
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
