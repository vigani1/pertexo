import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';

import { fireEvent, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { describe, expect, it } from 'vitest';

import {
  forEachDefinition,
  orderLoopGraph,
} from '../../../support/fixtures/for-each';

import {
  addStepButton,
  findCanvas,
  pressSave,
} from '../../../support/fixtures/editor-actions';
import {
  editorHandlers,
  editorPath,
  manualDefinition,
  mappingDefinition,
} from '../../../support/fixtures/workflow-editor';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { conditionDefinition, graph } from './fixture';

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
