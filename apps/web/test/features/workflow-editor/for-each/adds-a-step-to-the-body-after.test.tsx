import type { WorkflowGraphContract } from '@pertexo/contracts';

import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { describe, expect, it } from 'vitest';

import {
  link,
  loopStep,
  orderLoopGraph,
  step,
} from '../../../support/fixtures/for-each';

import {
  choose,
  pressSave,
  toastAction,
} from '../../../support/fixtures/editor-actions';

import { openByKeyboard, openEditor, savedBody } from './fixture';

describe('building a For each body', { timeout: 30_000 }, () => {
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
    // An expression in the body can read the item too.
    await event.click(screen.getByRole('button', { name: 'Expression' }));
    const expression = screen.getByLabelText('Expression');
    expect(expression).toHaveAttribute(
      'placeholder',
      'loop.item.amount > 5000',
    );
    expect(expression).toHaveAccessibleDescription(
      /loop\.item \(the item this pass runs for\), loop\.ordinal, runInput/u,
    );
    await event.click(screen.getByRole('button', { name: 'Loop item' }));

    await event.click(screen.getByRole('button', { name: 'Link a step' }));
    await event.click(screen.getByLabelText('Link from step'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Choose a step',
      'Reserve item',
    ]);
    await event.keyboard('{Escape}');
    await choose(event, 'Link from step', 'Reserve item');
    await choose(event, 'From output', 'out');
    await choose(event, 'Into input', 'in');
    await event.click(screen.getByRole('button', { name: 'Link' }));
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
