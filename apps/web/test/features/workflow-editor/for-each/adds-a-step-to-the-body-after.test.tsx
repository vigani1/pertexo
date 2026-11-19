import type { WorkflowGraphContract } from '@pertexo/contracts';

import { screen, waitFor, within } from '@testing-library/react';

import { describe, expect, it } from 'vitest';

import {
  link,
  loopStep,
  orderLoopGraph,
  step,
} from '../../../support/fixtures/for-each';

import { choose, pressSave } from '../../../support/fixtures/editor-actions';

import { openByKeyboard, openEditor, savedBody } from './fixture';

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
