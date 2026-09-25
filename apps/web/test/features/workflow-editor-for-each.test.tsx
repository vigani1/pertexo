import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { projectWorkflowGraph } from '@/features/workflow-editor/model/graph-adapter';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  editorHandlers,
  editorPath,
  findCanvas,
  setDefinition,
} from '../support/workflow-editor-fixtures';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

const forEachDefinition = {
  ...setDefinition,
  definition: { key: 'core.foreach', version: 1 },
  family: 'logic',
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
} satisfies NodeDefinitionCatalogItem;

function step(id: string, label: string): WorkflowNode {
  return {
    id,
    label,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}

const loop: WorkflowNode = {
  ...step('loop', 'Each order'),
  definition: { key: 'core.foreach', version: 1 },
  position: { x: 80, y: 80 },
  inputMappings: { items: { kind: 'run_input', path: '$.orders' } },
  structured: {
    kind: 'for_each',
    maxIterations: 100,
    maxConcurrency: 5,
    body: {
      schemaVersion: 1,
      nodes: [
        step('check', 'Check stock'),
        step('reserve', 'Reserve item'),
        step('notify', 'Tell the buyer'),
        step('log', 'Record result'),
      ],
      edges: [],
      settings: {},
      inputPorts: ['item', 'ordinal'],
      outputPorts: ['result'],
    },
  },
};

const graph: WorkflowGraphContract = {
  schemaVersion: 1,
  nodes: [
    loop,
    {
      ...step('unbuilt', 'Unbuilt loop'),
      definition: { key: 'core.foreach', version: 1 },
      position: { x: 480, y: 80 },
    },
    { ...step('after', 'After the loop'), position: { x: 880, y: 80 } },
  ],
  edges: [
    {
      id: 'loop-after',
      source: { nodeId: 'loop', port: 'out' },
      target: { nodeId: 'after', port: 'in' },
    },
  ],
  settings: {},
};

describe('For each on the canvas', { timeout: 30_000 }, () => {
  it('projects For each steps as containers without touching the graph', () => {
    const before = JSON.stringify(graph);
    const projection = projectWorkflowGraph(graph, [
      forEachDefinition,
      setDefinition,
    ]);
    expect(projection.nodes.map((node) => node.type)).toEqual([
      'forEach',
      'forEach',
      'workflow',
    ]);
    expect(projection.nodes[0]?.data.loop).toEqual({
      maxIterations: 100,
      maxConcurrency: 5,
      steps: [
        { id: 'check', title: 'Check stock' },
        { id: 'reserve', title: 'Reserve item' },
        { id: 'notify', title: 'Tell the buyer' },
        { id: 'log', title: 'Record result' },
      ],
      inputs: ['item', 'ordinal'],
      outputs: ['result'],
    });
    expect(projection.nodes[1]?.data.loop).toBeNull();
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('draws the body, its done output and bounds, and opens by keyboard', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph,
        definitions: [forEachDefinition, setDefinition],
      }),
    );
    renderApp(editorPath);
    const canvas = await findCanvas();
    // Unmeasured canvas nodes are hidden in jsdom, so find them by label.
    const card = canvas.getByLabelText('Each order, For each');
    const body = within(card).getByLabelText('Body, runs once per item');
    expect(within(body).getByText('Check stock')).toBeInTheDocument();
    expect(within(body).getByText('Tell the buyer')).toBeInTheDocument();
    expect(within(body).queryByText('Record result')).toBeNull();
    expect(within(body).getByText('+1 more step')).toBeInTheDocument();
    expect(within(body).getByText(/item · ordinal/u)).toBeInTheDocument();
    expect(within(card).getByText('up to 100 items')).toBeInTheDocument();
    expect(within(card).getByText('5 at a time')).toBeInTheDocument();
    expect(
      within(card).getByLabelText('Each order: output done'),
    ).toHaveAttribute('data-handleid', 'out');
    expect(
      within(canvas.getByLabelText('Unbuilt loop, For each')).getByText(
        /No body yet/u,
      ),
    ).toBeInTheDocument();

    const node = card.closest<HTMLElement>('.react-flow__node');
    if (node === null) throw new Error('The card is not a canvas node');
    node.focus();
    fireEvent.keyDown(node, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Label')).toHaveValue('Each order');
    });
    const summary = screen.getByRole('region', { name: 'Runs once per item' });
    expect(summary).toHaveTextContent('up to 100 items and 5 at a time');
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Check stock',
      'Reserve item',
      'Tell the buyer',
      'Record result',
    ]);
  });
});
