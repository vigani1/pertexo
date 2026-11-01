import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { chooseIn } from '../../../../support/fixtures/inspector-session';
import type { JsonValue } from '@pertexo/workflow-model';
import {
  answer,
  comparisonAt,
  fieldAt,
  openCheck,
  orderGraph,
  pickField,
  typeValue,
  valueAt,
  type Condition,
} from './fixture';

describe('building a rule', { timeout: 60_000 }, () => {
  it('opens Setup on rules and saves one as the step’s condition input', async () => {
    const session = await openCheck(
      orderGraph(undefined, { note: { kind: 'literal', value: 'keep me' } }),
    );
    expect(await screen.findByLabelText('Field')).toHaveTextContent(
      'Choose a field',
    );
    expect(screen.queryByText(/Nothing to set up/u)).toBeNull();
    await pickField(session, 0, /^state/u);
    expect(fieldAt(0)).toHaveTextContent('Fetch order · state');
    typeValue(0, 'paid');
    await session.saved(() => {
      expect(session.savedStep('check')?.inputMappings).toEqual({
        note: { kind: 'literal', value: 'keep me' },
        condition: expect.objectContaining({
          kind: 'expression',
          language: 'jsonata',
        }) as Condition,
      });
    });
    expect(session.savedStep('check')?.config).toEqual({});
    const stored = session.savedStep('check')?.inputMappings.condition;
    await expect(answer(stored, { state: 'PAID' })).resolves.toMatchObject({
      kind: 'value',
      value: true,
    });
    await expect(answer(stored, { state: 'open' })).resolves.toMatchObject({
      kind: 'value',
      value: false,
    });
    await expect(answer(stored, {})).resolves.toMatchObject({
      kind: 'value',
      value: false,
    });
  });

  // The value typed, then a run's output that matches and one that doesn't.
  const COMPARISONS: readonly (readonly [
    string,
    string,
    JsonValue | undefined,
    JsonValue | undefined,
  ])[] = [
    ['is equal to', 'paid', 'Paid', 'open'],
    ['is not equal to', 'paid', 'open', 'Paid'],
    ['contains', 'AI', 'paid', 'open'],
    ['doesn’t contain', 'AI', 'open', 'paid'],
    ['starts with', 'PA', 'paid', 'open'],
    ['ends with', 'ID', 'paid', 'open'],
    ['is greater than', '3', 4, 3],
    ['is at least', '3', 3, 2],
    ['is less than', '3', 2, 3],
    ['is at most', '3', 3, 4],
    ['is true', '', true, false],
    ['is false', '', false, true],
    ['exists', '', 'anything', undefined],
    ['doesn’t exist', '', undefined, 'anything'],
    ['is empty', '', '', 'full'],
    ['isn’t empty', '', 'full', ''],
  ];

  it('gives the right answer for every comparison chosen on screen', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    await pickField(session, 0, /^state/u);
    let previous: unknown;
    for (const [label, value, matching, other] of COMPARISONS) {
      await chooseIn(session.event, comparisonAt(0), label);
      if (value === '')
        expect(valueAt(0)).toHaveAttribute('placeholder', 'No value needed');
      else typeValue(0, value);
      await session.saved(() => {
        const current = session.savedStep('check')?.inputMappings.condition;
        expect(current).not.toEqual(previous);
        expect(current).toBeDefined();
      });
      const stored = session.savedStep('check')?.inputMappings.condition;
      previous = stored;
      const output = (state: JsonValue | undefined): JsonValue =>
        state === undefined ? {} : { state };
      await expect(
        answer(stored, output(matching)),
        `${label} on ${JSON.stringify(matching)}`,
      ).resolves.toMatchObject({ kind: 'value', value: true });
      await expect(
        answer(stored, output(other)),
        `${label} on ${JSON.stringify(other)}`,
      ).resolves.toMatchObject({ kind: 'value', value: false });
    }
  });

  it('starts a rule’s comparison from its field’s type', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    await pickField(session, 0, /^status/u);
    expect(comparisonAt(0)).toHaveTextContent('is greater than');
    await session.event.click(screen.getByRole('button', { name: 'Add rule' }));
    await pickField(session, 1, /^verified/u);
    expect(comparisonAt(1)).toHaveTextContent('is true');
    expect(valueAt(1)).toBeDisabled();
    expect(valueAt(1)).toHaveAttribute('placeholder', 'No value needed');
    await session.event.click(screen.getByRole('button', { name: 'Add rule' }));
    await pickField(session, 2, /^state/u);
    expect(comparisonAt(2)).toHaveTextContent('is equal to');
  });

  it('changes a real run’s outcome when switching All and Any', async () => {
    const session = await openCheck(orderGraph());
    await screen.findByLabelText('Field');
    const combine = screen.getByRole('group', {
      name: 'How the rules combine',
    });
    // One rule has nothing to combine, yet the switch keeps its place.
    expect(
      within(combine).getByRole('button', { name: 'Any can match' }),
    ).toBeDisabled();
    await pickField(session, 0, /^state/u);
    typeValue(0, 'paid');
    await session.event.click(screen.getByRole('button', { name: 'Add rule' }));
    await pickField(session, 1, /^status/u);
    typeValue(1, '500');
    await session.saved(() => {
      expect(session.saves.at(-1)).toBeDefined();
      expect(
        JSON.stringify(session.savedStep('check')?.inputMappings.condition),
      ).toContain(' and ');
    });
    const onlyOneMatches = { state: 'Paid', status: 200 };
    const bothMatch = { state: 'Paid', status: 600 };
    const neither = { state: 'open', status: 200 };
    const stored = () => session.savedStep('check')?.inputMappings.condition;
    for (const [output, value] of [
      [onlyOneMatches, false],
      [bothMatch, true],
      [neither, false],
    ] as const)
      await expect(answer(stored(), output)).resolves.toMatchObject({ value });

    await session.event.click(
      within(combine).getByRole('button', { name: 'Any can match' }),
    );
    await session.saved(() => {
      expect(JSON.stringify(stored())).toContain(') or (');
    });
    for (const [output, value] of [
      [onlyOneMatches, true],
      [bothMatch, true],
      [neither, false],
    ] as const)
      await expect(answer(stored(), output)).resolves.toMatchObject({ value });

    await session.event.click(
      within(combine).getByRole('button', { name: 'All must match' }),
    );
    await session.saved(() => {
      expect(JSON.stringify(stored())).toContain(') and (');
    });
    await expect(answer(stored(), onlyOneMatches)).resolves.toMatchObject({
      value: false,
    });
  });
});
