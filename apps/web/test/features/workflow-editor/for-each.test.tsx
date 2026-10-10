import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { BODY_ORIGIN } from '@/features/workflow-editor/model/graph/for-each-body-layout';
import { projectWorkflowGraph } from '@/features/workflow-editor/model/graph/adapter';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  bodyStepDefinition,
  forEachDefinition,
  link,
  loopStep,
  orderLoopGraph,
  step,
} from '../../support/fixtures/for-each';
import {
  choose,
  checkNow,
  compatibility,
  editorHandlers,
  editorPath,
  etagA,
  findCanvas,
  pressSave,
  toastAction,
  workflowApi,
} from '../../support/fixtures/workflow-editor';

const definitions = [forEachDefinition, bodyStepDefinition];

/** Renders the editor on `graph`, collecting what it saves. */
async function openEditor(
  graph: WorkflowGraphContract,
  options: Readonly<{
    strict?: boolean;
    capabilities?: readonly string[];
  }> = {},
) {
  const saved: { graph?: WorkflowGraphContract } = {};
  mockServer.use(
    ...editorHandlers(
      (_request, body) => {
        saved.graph = body.graph;
      },
      { graph, definitions, ...options },
    ),
  );
  renderApp(editorPath, options);
  const canvas = await findCanvas();
  return { canvas, saved, event: userEvent.setup() };
}

/** Focuses a step on the canvas and presses Enter, as a keyboard user does. */
function openByKeyboard(card: HTMLElement) {
  const node = card.closest<HTMLElement>('.react-flow__node');
  if (node === null) throw new Error('The card is not a canvas node');
  node.focus();
  fireEvent.keyDown(node, { key: 'Enter' });
  return node;
}

function savedBody(saved: { graph?: WorkflowGraphContract }) {
  return saved.graph?.nodes.find((node) => node.id === 'loop')?.structured
    ?.body;
}

describe('For each on the canvas', () => {
  it('projects a For each as a container whose body steps are its children', () => {
    const graph = orderLoopGraph();
    const before = JSON.stringify(graph);
    const projection = projectWorkflowGraph(graph, definitions);
    expect(
      projection.nodes.map((node) => [node.id, node.type, node.parentId]),
    ).toEqual([
      ['start', 'workflow', undefined],
      ['loop', 'forEach', undefined],
      ['check', 'workflow', 'loop'],
      ['reserve', 'workflow', 'loop'],
      ['after', 'workflow', undefined],
    ]);
    const [, loop, check, reserve] = projection.nodes;
    expect(check?.position).toEqual(BODY_ORIGIN);
    // Stored on top of "check", so it's shown in the next column.
    expect(reserve?.position).toEqual({
      x: BODY_ORIGIN.x + 288,
      y: BODY_ORIGIN.y,
    });
    expect(reserve?.extent).toEqual([
      [BODY_ORIGIN.x, BODY_ORIGIN.y],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ]);
    expect(check?.data.bodyResult).toBe(false);
    expect(reserve?.data.bodyResult).toBe(true);
    expect(loop?.data.loop).toMatchObject({
      maxIterations: 100,
      maxConcurrency: 5,
      inputs: ['item', 'ordinal'],
      outputs: ['result'],
    });
    expect(loop?.data.body).toMatchObject({ width: 544, height: 112 });
    expect(projection.edges.map((edge) => edge.id)).toEqual([
      'check-reserve',
      'start-loop',
      'loop-after',
    ]);
    expect(JSON.stringify(graph)).toBe(before);
  });
});

describe('building a For each body', { timeout: 30_000 }, () => {
  it.each([
    { path: 'config.value', control: 'Value', value: '' },
    {
      path: 'inputMappings.expressionProof',
      control: 'Field',
      value: 'expressionProof',
    },
  ])(
    'keeps nested $path findings actionable without changing tabs before scratch approval',
    async ({ path, control, value }) => {
      mockServer.use(
        http.post(`${workflowApi}/validate`, () =>
          HttpResponse.json(
            {
              valid: false,
              issues: [
                {
                  path: `$.nodes.loop.structured.body.nodes.check.${path}`,
                  code: 'invalid_expression',
                  message: 'expression syntax is invalid',
                },
              ],
              compatibility,
            },
            { headers: { etag: etagA } },
          ),
        ),
      );
      const graph = orderLoopGraph();
      const check = graph.nodes[1]?.structured?.body.nodes[0];
      if (check === undefined) throw new Error('Body step missing');
      const withExpression = {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.structured === undefined
            ? node
            : {
                ...node,
                structured: {
                  ...node.structured,
                  body: {
                    ...node.structured.body,
                    nodes: node.structured.body.nodes.map((bodyNode) =>
                      bodyNode.id !== check.id
                        ? bodyNode
                        : {
                            ...bodyNode,
                            inputMappings: {
                              expressionProof: {
                                kind: 'expression',
                                language: 'jsonata',
                                expression: '(',
                              },
                            },
                          },
                    ),
                  },
                },
              },
        ),
      } satisfies WorkflowGraphContract;
      const { event, saved } = await openEditor(withExpression, {
        strict: true,
      });
      await checkNow(event);
      expect(
        await screen.findByText('Expression syntax is invalid.'),
      ).toBeVisible();
      await event.click(screen.getByRole('button', { name: 'Close issues' }));
      openByKeyboard(screen.getByLabelText('Each order, For each'));
      const items = await screen.findByLabelText('Maximum items');
      fireEvent.change(items, { target: { value: '-' } });
      await event.click(screen.getByRole('button', { name: '1 issue' }));
      await event.click(
        screen.getByRole('button', {
          name: 'Fix: Expression syntax is invalid.',
        }),
      );
      expect(
        await screen.findByRole('dialog', {
          name: 'Discard the unfinished edit?',
        }),
      ).toBeVisible();
      expect(
        screen.getByRole('tab', { name: 'Setup', hidden: true }),
      ).toHaveAttribute('aria-selected', 'true');
      await event.click(screen.getByRole('button', { name: 'Stay' }));
      expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(items).toBeVisible();
      expect(items).toHaveValue('-');
      expect(screen.getByLabelText('Label')).toHaveValue('Each order');
      expect(saved.graph).toBeUndefined();
      await event.click(screen.getByRole('button', { name: '1 issue' }));
      await event.click(
        screen.getByRole('button', {
          name: 'Fix: Expression syntax is invalid.',
        }),
      );
      await event.click(
        await screen.findByRole('button', { name: 'Discard edit' }),
      );
      await waitFor(() => {
        expect(screen.getByLabelText(control)).toHaveFocus();
      });
      expect(screen.getByLabelText(control)).toHaveValue(value);
    },
  );

  it('live-applies compatible limits together under StrictMode without losing the body, then undoes and redoes', async () => {
    const graph = orderLoopGraph();
    const { saved, event } = await openEditor(graph, { strict: true });
    openByKeyboard(screen.getByLabelText('Each order, For each'));
    const items = await screen.findByLabelText('Maximum items');
    const concurrent = screen.getByLabelText('Items at a time');
    fireEvent.change(items, { target: { value: '1' } });
    fireEvent.blur(items);
    expect(concurrent).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByText('Items at a time cannot exceed Maximum items.'),
    ).toBeVisible();
    // A valid sibling correction commits both, rather than clamping either.
    fireEvent.change(concurrent, { target: { value: '1' } });
    pressSave();
    await waitFor(() => {
      expect(
        saved.graph?.nodes.find((node) => node.id === 'loop')?.structured,
      ).toEqual({
        ...graph.nodes[1]?.structured,
        maxIterations: 1,
        maxConcurrency: 1,
      });
    });
    await event.click(screen.getByRole('button', { name: /Undo/u }));
    expect(items).toHaveValue('100');
    expect(concurrent).toHaveValue('5');
    await event.click(screen.getByRole('button', { name: /Redo/u }));
    expect(items).toHaveValue('1');
    expect(concurrent).toHaveValue('1');
    const maximum = WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopIterations;
    fireEvent.change(items, { target: { value: String(maximum) } });
    fireEvent.change(concurrent, { target: { value: String(maximum) } });
    pressSave();
    await waitFor(() => {
      expect(
        saved.graph?.nodes.find((node) => node.id === 'loop')?.structured,
      ).toEqual({
        ...graph.nodes[1]?.structured,
        maxIterations: maximum,
        maxConcurrency: maximum,
      });
    });
  });

  it.each([
    '',
    '0',
    '-1',
    '-',
    '1e',
    '1.5',
    String(WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopIterations + 1),
  ])(
    'keeps incomplete or invalid bounds %j as scratch and protects selection',
    async (text) => {
      const { saved, event } = await openEditor(orderLoopGraph());
      openByKeyboard(screen.getByLabelText('Each order, For each'));
      const items = await screen.findByLabelText('Maximum items');
      fireEvent.change(items, { target: { value: text } });
      fireEvent.blur(items);
      expect(items).toHaveValue(text);
      expect(items).toHaveAttribute('aria-invalid', 'true');
      const section = screen.getByRole('region', {
        name: 'Runs once per item',
      });
      await event.click(
        within(section).getByRole('button', { name: 'Check stock' }),
      );
      expect(
        await screen.findByRole('dialog', {
          name: 'Discard the unfinished edit?',
        }),
      ).toBeVisible();
      await event.click(screen.getByRole('button', { name: 'Stay' }));
      expect(items).toHaveValue(text);
      expect(saved.graph).toBeUndefined();
      await event.click(
        within(section).getByRole('button', { name: 'Check stock' }),
      );
      await event.click(
        await screen.findByRole('button', { name: 'Discard edit' }),
      );
      pressSave();
      // Discarding scratch leaves the original graph unchanged.
      expect(saved.graph).toBeUndefined();
    },
  );

  it('shows limits without permitting changes for a read-only actor', async () => {
    await openEditor(orderLoopGraph(), { capabilities: ['workflow:read'] });
    openByKeyboard(screen.getByLabelText('Each order, For each'));
    expect(await screen.findByLabelText('Maximum items')).toBeDisabled();
    expect(screen.getByLabelText('Items at a time')).toBeDisabled();
  });

  it('draws the body in place and inspects the For each from the keyboard', async () => {
    const { canvas } = await openEditor(orderLoopGraph());
    // Unmeasured canvas nodes are hidden in jsdom, so find them by label.
    const card = canvas.getByLabelText('Each order, For each');
    const body = within(card).getByLabelText('Body, runs once per item');
    expect(within(body).getByText(/item · ordinal/u)).toBeInTheDocument();
    expect(within(card).getByText('up to 100 items')).toBeInTheDocument();
    expect(within(card).getByText('5 at a time')).toBeInTheDocument();
    expect(
      within(card).getByLabelText('Each order: output done'),
    ).toHaveAttribute('data-handleid', 'out');
    const reserve = canvas.getByLabelText('Reserve item, Set fields');
    expect(reserve.closest('.react-flow__node')).toHaveAttribute(
      'data-id',
      'reserve',
    );
    expect(within(reserve).getByText('Gives the result')).toBeInTheDocument();

    openByKeyboard(card);
    await waitFor(() => {
      expect(screen.getByLabelText('Label')).toHaveValue('Each order');
    });
    const section = screen.getByRole('region', { name: 'Runs once per item' });
    expect(section).toHaveTextContent('up to 100 items and 5 at a time');
    expect(
      within(within(section).getByRole('list', { name: 'Body steps' }))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Check stock', 'Reserve item']);
  });

  it('adds a step to the body after its last step, from the keyboard', async () => {
    const { saved, event } = await openEditor(orderLoopGraph());
    openByKeyboard(screen.getByLabelText('Each order, For each'));
    const add = await screen.findByRole('button', { name: 'Add step to body' });
    add.focus();
    await event.keyboard('{Enter}');
    const lens = await screen.findByRole('dialog', {
      name: 'Add a step after “Reserve item”',
    });
    await waitFor(() => {
      expect(within(lens).getByRole('searchbox')).toHaveFocus();
    });
    await event.keyboard('set');
    await event.click(
      within(lens).getByRole('button', { name: /Set fields/u }),
    );
    pressSave();
    await waitFor(() => {
      expect(savedBody(saved)?.nodes).toHaveLength(3);
    });
    const added = savedBody(saved)?.nodes[2];
    expect(savedBody(saved)?.edges.at(-1)).toMatchObject({
      source: { nodeId: 'reserve', port: 'out' },
      target: { nodeId: added?.id, port: 'in' },
    });
    // Placed right of the last step, which was stored where it's shown.
    expect(savedBody(saved)?.nodes[1]?.position).toEqual({ x: 288, y: 0 });
    expect(added?.position.x).toBeGreaterThan(288);
    expect(saved.graph?.nodes).toHaveLength(3);
  });

  it('adds a first step from the container’s own Add step', async () => {
    const graph: WorkflowGraphContract = {
      nodes: [loopStep('loop', 'Each order', { nodes: [], edges: [] })],
      edges: [],
      settings: {},
    };
    const { canvas, saved, event } = await openEditor(graph);
    const card = canvas.getByLabelText(
      'Each order, For each, body needs 1 fix',
    );
    expect(within(card).getByText(/The body is empty/u)).toBeInTheDocument();
    // Canvas nodes stay hidden until measured, which jsdom never does, so
    // their controls are found by label rather than by role.
    await event.click(
      within(card).getByLabelText('Add a step to Each order’s body'),
    );
    const lens = await screen.findByRole('dialog', {
      name: 'Add a step to “Each order”',
    });
    await event.click(
      within(lens).getByRole('button', { name: /Set fields/u }),
    );
    pressSave();
    await waitFor(() => {
      expect(savedBody(saved)?.nodes).toHaveLength(1);
    });
    expect(savedBody(saved)?.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(saved.graph?.nodes).toHaveLength(1);
  });
});

describe('working inside a For each body', { timeout: 30_000 }, () => {
  it('maps the loop item and connects only steps inside the body', async () => {
    const { saved, event } = await openEditor(orderLoopGraph());
    openByKeyboard(screen.getByLabelText('Each order, For each'));
    const section = await screen.findByRole('region', {
      name: 'Runs once per item',
    });
    await event.click(
      within(section).getByRole('button', { name: 'Check stock' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Label')).toHaveValue('Check stock');
    });
    await event.click(screen.getByRole('tab', { name: 'Inputs' }));
    await event.click(screen.getByRole('button', { name: 'Insert data' }));
    const picker = await screen.findByRole('dialog', { name: 'Insert data' });
    expect(within(picker).getByText('This item')).toBeInTheDocument();
    await event.click(
      within(picker).getByRole('button', { name: /Whole item/u }),
    );
    expect(screen.getByLabelText('Field')).toHaveValue('item');
    expect(screen.getByRole('button', { name: 'Loop item' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    pressSave();
    await waitFor(() => {
      expect(savedBody(saved)?.nodes[0]?.inputMappings).toEqual({
        item: { kind: 'structured_input', port: 'item', path: '$' },
      });
    });

    await event.click(screen.getByRole('button', { name: 'Connect a step' }));
    await event.click(screen.getByLabelText('Connect from step'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Choose a step',
      'Reserve item',
    ]);
    await event.keyboard('{Escape}');
    await choose(event, 'Connect from step', 'Reserve item');
    await choose(event, 'From output', 'out');
    await choose(event, 'Into input', 'in');
    await event.click(screen.getByRole('button', { name: 'Connect' }));
    pressSave();
    await waitFor(() => {
      expect(savedBody(saved)?.edges.map((edge) => edge.id)).toHaveLength(2);
    });
    expect(saved.graph?.edges.map((edge) => edge.id)).toEqual([
      'start-loop',
      'loop-after',
    ]);
  });

  it('deletes a body step from the keyboard, with Undo', async () => {
    const { canvas, saved, event } = await openEditor(orderLoopGraph());
    const node = openByKeyboard(
      canvas.getByLabelText('Check stock, Set fields'),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Label')).toHaveValue('Check stock');
    });
    node.focus();
    fireEvent.keyDown(node, { key: 'Backspace' });
    expect(await screen.findByText('Deleted “Check stock”')).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(savedBody(saved)?.nodes.map((item) => item.id)).toEqual([
        'reserve',
      ]);
    });
    expect(savedBody(saved)?.edges).toEqual([]);
    await event.click(toastAction('Undo'));
    pressSave();
    await waitFor(() => {
      expect(savedBody(saved)?.nodes.map((item) => item.id)).toEqual([
        'check',
        'reserve',
      ]);
    });
    expect(savedBody(saved)?.edges.map((edge) => edge.id)).toEqual([
      'check-reserve',
    ]);
  });

  it('shows what a body still needs on the card and in the inspector', async () => {
    const graph: WorkflowGraphContract = {
      nodes: [
        loopStep('loop', 'Each order', {
          nodes: [
            step('check', 'Check stock'),
            step('ship', 'Ship it', { x: 300, y: 0 }),
            step('mail', 'Mail it', { x: 300, y: 120 }),
          ],
          edges: [
            link('check-ship', 'check', 'ship'),
            link('check-mail', 'check', 'mail'),
          ],
        }),
      ],
      edges: [],
      settings: {},
    };
    const { canvas } = await openEditor(graph);
    const card = canvas.getByLabelText(
      'Each order, For each, body needs 1 fix',
    );
    const needs = within(card).getByLabelText('What the body needs');
    expect(needs).toHaveTextContent(
      'The body ends in 2 steps: “Ship it” and “Mail it”.',
    );
    openByKeyboard(card);
    const section = await screen.findByRole('region', {
      name: 'Runs once per item',
    });
    expect(within(section).getByRole('status')).toHaveTextContent(
      'The body isn’t ready yet',
    );
  });
});
