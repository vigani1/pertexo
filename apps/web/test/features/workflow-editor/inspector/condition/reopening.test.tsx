import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { chooseIn } from '../../../../support/fixtures/inspector-session';
import {
  answer,
  asExpression,
  comparisonAt,
  fieldAt,
  noteText,
  openCheck,
  orderGraph,
  pickField,
  TWO_RULES,
  typeValue,
  valueAt,
  type Condition,
} from './fixture';

describe('reopening a condition', { timeout: 60_000 }, () => {
  it('shows a saved condition as the same rows and writes nothing', async () => {
    const session = await openCheck(orderGraph(asExpression(TWO_RULES)));
    expect(await screen.findAllByLabelText('Field')).toHaveLength(2);
    expect(fieldAt(0)).toHaveTextContent('Fetch order · status');
    expect(comparisonAt(0)).toHaveTextContent('is at least');
    expect(valueAt(0)).toHaveValue('200');
    expect(fieldAt(1)).toHaveTextContent('Fetch order · customer.name');
    expect(comparisonAt(1)).toHaveTextContent('is equal to');
    expect(valueAt(1)).toHaveValue('ada');
    expect(
      screen.getByRole('button', { name: 'Any can match', pressed: true }),
    ).toBeVisible();
    await session.expectNothingSaved();
  });

  it.each([
    ['an unquoted field', 'nodeOutputs."id".status = 200'],
    ['a function count', 'runInput.a > 1 and $count(runInput.b) > 2'],
    [
      'extra whitespace',
      '$lowercase($string(runInput."a"))  =  $lowercase("x")',
    ],
    [
      'mixed and and or',
      '(runInput."a" = true) and (runInput."b" = true) or (runInput."c" = true)',
    ],
    [
      'an empty text value',
      '$lowercase($string(runInput."a")) = $lowercase("")',
    ],
  ])(
    'keeps an expression with %s exactly as written',
    async (_name, expression) => {
      const session = await openCheck(orderGraph(asExpression(expression)));
      const shown = () =>
        screen.getByLabelText<HTMLTextAreaElement>('Expression');
      expect(await screen.findByText(noteText)).toBeVisible();
      expect(shown().value).toBe(expression);
      expect(screen.getByRole('button', { name: 'Rules' })).toBeDisabled();
      expect(screen.queryByLabelText('Field')).toBeNull();

      await session.event.click(screen.getByRole('tab', { name: 'Inputs' }));
      await session.event.click(screen.getByRole('tab', { name: 'Setup' }));
      expect(shown().value).toBe(expression);
      session.select('Fetch order');
      session.select('Check order');
      expect(await screen.findByText(noteText)).toBeVisible();
      expect(shown().value).toBe(expression);
      await session.expectNothingSaved();
    },
  );

  it('opens a template’s true/false field as one is true rule until it’s edited', async () => {
    const pointedAt: Condition = {
      kind: 'node_output',
      nodeId: 'fetch',
      path: '$.verified',
    };
    const session = await openCheck(orderGraph(pointedAt));
    expect(await screen.findByLabelText('Field')).toHaveTextContent(
      'Fetch order · verified',
    );
    expect(comparisonAt(0)).toHaveTextContent('is true');
    await session.event.click(
      screen.getByRole('button', { name: 'Expression' }),
    );
    await session.event.click(screen.getByRole('button', { name: 'Rules' }));
    await session.expectNothingSaved();

    await chooseIn(session.event, comparisonAt(0), 'is false');
    await session.saved(() => {
      expect(session.savedStep('check')?.inputMappings.condition).toMatchObject(
        { kind: 'expression' },
      );
    });
    await expect(
      answer(session.savedStep('check')?.inputMappings.condition, {
        verified: false,
      }),
    ).resolves.toMatchObject({ value: true });
  });

  it('points a fixed value to Inputs and leaves it alone', async () => {
    const session = await openCheck(
      orderGraph({ kind: 'literal', value: true }),
    );
    expect(
      await screen.findByText(/uses a value only Inputs can show/u),
    ).toBeVisible();
    await session.expectNothingSaved();
    await session.event.click(
      screen.getByRole('button', { name: 'Go to Inputs' }),
    );
    expect(
      screen.getByRole('tab', { name: 'Inputs', selected: true }),
    ).toBeVisible();
  });

  it('frees Rules when the expression is cleared, and undo brings it back', async () => {
    const expression = 'runInput.a > 1 and $count(runInput.b) > 2';
    const session = await openCheck(orderGraph(asExpression(expression)));
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Expression');
    fireEvent.change(box, { target: { value: '' } });
    await session.saved(() => {
      expect(session.savedStep('check')?.inputMappings).toEqual({});
    });
    expect(screen.getByRole('button', { name: 'Rules' })).toBeEnabled();
    expect(screen.queryByText(noteText)).toBeNull();

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLTextAreaElement>('Expression').value,
      ).toBe(expression);
    });
    expect(screen.getByText(noteText)).toBeVisible();
    await session.saved(() => {
      expect(session.savedStep('check')?.inputMappings.condition).toEqual(
        asExpression(expression),
      );
    });
  });

  it('follows undo and redo of a rule', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    await pickField(session, 0, /^state/u);
    typeValue(0, 'paid');
    await waitFor(() => {
      expect(valueAt(0)).toHaveValue('paid');
    });
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => {
      expect(fieldAt(0)).toHaveTextContent('Choose a field');
    });
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(fieldAt(0)).toHaveTextContent('Fetch order · state');
    });
    expect(valueAt(0)).toHaveValue('paid');
  });

  it('keeps an unfinished rule while looking at the Expression view', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    typeValue(0, 'half done');
    await session.event.click(
      screen.getByRole('button', { name: 'Expression' }),
    );
    await session.event.click(screen.getByRole('button', { name: 'Rules' }));
    expect(valueAt(0)).toHaveValue('half done');
    await session.expectNothingSaved();
  });
});
