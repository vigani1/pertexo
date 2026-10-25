import { projectWorkflowGraph } from '@/features/workflow-editor/model/graph/adapter';

import { BODY_ORIGIN } from '@/features/workflow-editor/model/graph/for-each-body-layout';

import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  type WorkflowGraphContract,
} from '@pertexo/contracts';

import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { orderLoopGraph } from '../../support/fixtures/for-each';

import { checkNow, pressSave } from '../../support/fixtures/editor-actions';
import {
  compatibility,
  etagA,
  workflowApi,
} from '../../support/fixtures/workflow-editor';

import { mockServer } from '../../support/mock-server';

import { definitions, openByKeyboard, openEditor } from './for-each/fixture';

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
              currentPublication: null,
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
      await event.click(screen.getByRole('button', { name: /\d+ issues?/u }));
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
      await event.click(screen.getByRole('button', { name: /\d+ issues?/u }));
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
    const concurrency = WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopConcurrency;
    fireEvent.change(items, { target: { value: String(maximum) } });
    fireEvent.change(concurrent, { target: { value: String(concurrency) } });
    pressSave();
    await waitFor(() => {
      expect(
        saved.graph?.nodes.find((node) => node.id === 'loop')?.structured,
      ).toEqual({
        ...graph.nodes[1]?.structured,
        maxIterations: maximum,
        maxConcurrency: concurrency,
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
});
