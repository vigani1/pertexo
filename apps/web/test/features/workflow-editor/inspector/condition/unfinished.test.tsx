import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { chooseIn } from '../../../../support/fixtures/inspector-session';
import {
  asExpression,
  comparisonAt,
  fieldAt,
  NOT_VALID_YET,
  openCheck,
  orderGraph,
  pickField,
  TWO_RULES,
  typeValue,
  valueAt,
} from './fixture';

describe('unfinished rules', { timeout: 60_000 }, () => {
  it('stays quiet about a brand-new empty rule', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    expect(screen.queryByText(NOT_VALID_YET)).toBeNull();
    await session.expectNothingSaved();
  });

  it('holds a half-filled rule back until it’s finished', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    typeValue(0, 'paid');
    expect(await screen.findByText(NOT_VALID_YET)).toBeVisible();
    await session.expectNothingSaved();

    await pickField(session, 0, /^state/u);
    await session.saved(() => {
      expect(session.savedStep('check')?.inputMappings.condition).toMatchObject(
        { kind: 'expression' },
      );
    });
    await waitFor(() => {
      expect(screen.queryByText(NOT_VALID_YET)).toBeNull();
    });
  });

  it('drops the unfinished rule with Discard it', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    typeValue(0, 'paid');
    await session.event.click(
      await screen.findByRole('button', { name: 'Discard it' }),
    );
    await waitFor(() => {
      expect(valueAt(0)).toHaveValue('');
    });
    expect(screen.queryByText(NOT_VALID_YET)).toBeNull();
    await session.expectNothingSaved();
  });

  it('names a rule’s problem only once focus has left the rule', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    await session.event.click(valueAt(0));
    await session.event.keyboard('x');
    await session.event.tab({ shift: true });
    expect(screen.queryByText('Choose a field.')).toBeNull();

    // Opening the field picker opens outside the rule, which isn't leaving.
    await session.event.click(fieldAt(0));
    await screen.findByRole('dialog', { name: 'Insert data' });
    expect(screen.queryByText('Choose a field.')).toBeNull();
    await session.event.keyboard('{Escape}');

    await session.event.click(screen.getByRole('button', { name: 'Add rule' }));
    const message = await screen.findByText('Choose a field.');
    expect(fieldAt(0)).toHaveAttribute(
      'aria-describedby',
      message.closest('[aria-live]')?.id,
    );
    expect(valueAt(0)).toHaveAttribute(
      'aria-describedby',
      message.closest('[aria-live]')?.id,
    );
  });

  it.each([
    ['is equal to', '', 'Enter a value.'],
    ['is greater than', 'abc', 'Enter a number.'],
  ])('says what a %s rule needs', async (comparison, value, problem) => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    await pickField(session, 0, /^state/u);
    await chooseIn(session.event, comparisonAt(0), comparison);
    typeValue(0, value);
    fireEvent.focusOut(valueAt(0), { relatedTarget: document.body });
    expect(await screen.findByText(problem)).toBeVisible();
    expect(valueAt(0)).toHaveAttribute('aria-invalid', 'true');
  });

  it('empties the only rule and removes the stored input when it’s removed', async () => {
    const session = await openCheck(
      orderGraph(
        asExpression('$lowercase($string(runInput."a")) = $lowercase("x")'),
      ),
    );
    await session.event.click(
      await screen.findByRole('button', { name: 'Remove rule 1' }),
    );
    await session.saved(() => {
      expect(session.savedStep('check')?.inputMappings).toEqual({});
    });
    expect(fieldAt(0)).toHaveTextContent('Choose a field');
    expect(valueAt(0)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add rule' })).toHaveFocus();
  });

  it('moves focus to a new rule’s Field', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    await session.event.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => {
      expect(fieldAt(1)).toHaveFocus();
    });
  });

  it('lets a person type a whole value into a rule they just added', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    await pickField(session, 0, /^state/u);
    typeValue(0, 'paid');
    await session.event.click(screen.getByRole('button', { name: 'Add rule' }));
    await pickField(session, 1, /^status/u);
    await chooseIn(session.event, comparisonAt(1), 'is equal to');
    await session.event.click(valueAt(1));
    await session.event.keyboard('200');
    expect(valueAt(1)).toHaveFocus();
    expect(valueAt(1)).toHaveValue('200');
    await session.saved(() => {
      expect(
        JSON.stringify(session.savedStep('check')?.inputMappings.condition),
      ).toContain(String.raw`$lowercase(\"200\")`);
    });
  });

  it('says a field’s step no longer runs before this one, and keeps the condition', async () => {
    const expression =
      '$lowercase($string(nodeOutputs."gone"."state")) = $lowercase("x")';
    const session = await openCheck(orderGraph(asExpression(expression)));
    expect(
      await screen.findByText(/no longer runs before this one/u),
    ).toBeVisible();
    await session.expectNothingSaved();
  });

  it('shows a read-only viewer the rules with every control disabled', async () => {
    await openCheck(orderGraph(asExpression(TWO_RULES)), {
      capabilities: ['workspace:read', 'workflow:read', 'run:read'],
    });
    expect(await screen.findAllByLabelText('Field')).toHaveLength(2);
    for (const rule of [0, 1]) {
      expect(fieldAt(rule)).toBeDisabled();
      expect(valueAt(rule)).toBeDisabled();
      expect(comparisonAt(rule)).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expression' })).toBeDisabled();
  });
});
