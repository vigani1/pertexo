import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  openEditor,
  pinHandler,
  type GraphNode,
} from '../../../../support/fixtures/inspector-session';
import {
  chain,
  direct,
  evaluator,
  mappingIssues,
  openPicker,
  walk,
  type Session,
} from './fixture';

describe('what picking writes', { timeout: 60_000 }, () => {
  const SAMPLE = {
    status: 200,
    customer: { name: 'Ada', 'customer-name': 'Lovelace' },
    items: [{ id: 7 }],
  };

  it.each([
    { name: /^status/u, key: 'status', path: '$.status', value: 200 },
    {
      name: /^nameAda/u,
      key: 'name',
      path: '$.customer.name',
      value: 'Ada',
    },
    {
      name: /^customer-name/u,
      key: 'customer-name',
      path: "$.customer['customer-name']",
      value: 'Lovelace',
    },
    {
      name: /^id7/u,
      key: 'id',
      path: '$.items[0].id',
      value: 7,
    },
  ])(
    'writes a direct link’s $path as a step output the engine accepts',
    async ({ name, key, path, value }) => {
      const session = await openEditor(direct(), {
        handlers: [pinHandler('fetch', SAMPLE)],
      });
      const picker = await openPicker(session);
      await session.event.click(await picker.findByRole('button', { name }));
      await session.saved(() => {
        expect(session.savedStep('target')?.inputMappings[key]).toEqual({
          kind: 'node_output',
          nodeId: 'fetch',
          path,
        });
      });
      expect(walk(SAMPLE, path)).toEqual(value);
      expect(mappingIssues(session.saves.at(-1))).toEqual([]);
    },
  );

  it('writes a step further back as an expression, which the engine accepts and a run resolves', async () => {
    const session = await openEditor(chain(), {
      handlers: [pinHandler('fetch', SAMPLE)],
    });
    const picker = await openPicker(session);
    await session.event.click(
      picker.getByRole('button', { name: 'Fetch order' }),
    );
    await session.event.click(
      await picker.findByRole('button', { name: /^nameAda/u }),
    );
    await session.saved(() => {
      expect(session.savedStep('target')?.inputMappings.name).toEqual({
        kind: 'expression',
        language: 'jsonata',
        expression: 'nodeOutputs."fetch"."customer"."name"',
      });
    });
    const saved = session.saves.at(-1);
    expect(mappingIssues(saved)).toEqual([]);
    await expect(
      evaluator.evaluate({
        expression: 'nodeOutputs."fetch"."customer"."name"',
        context: { runInput: {}, nodeOutputs: { fetch: SAMPLE } },
      }),
    ).resolves.toMatchObject({ kind: 'value', value: 'Ada' });

    // Why it matters: the engine turns away the same read as a step output.
    const asStepOutput = chain({
      name: { kind: 'node_output', nodeId: 'fetch', path: '$.customer.name' },
    });
    expect(mappingIssues(asStepOutput)).toContain('invalid_mapping');
  });

  it('keeps a further-back read an expression after leaving and returning to the step', async () => {
    const session = await openEditor(chain(), {
      handlers: [pinHandler('fetch', SAMPLE)],
    });
    const picker = await openPicker(session);
    await session.event.click(
      picker.getByRole('button', { name: 'Fetch order' }),
    );
    await session.event.click(
      await picker.findByRole('button', { name: /^status/u }),
    );
    session.select('Middle');
    session.select('Target');
    fireEvent.click(await screen.findByRole('tab', { name: 'Inputs' }));
    await session.saved(() => {
      expect(session.savedStep('target')?.inputMappings.status).toMatchObject({
        kind: 'expression',
      });
    });
    expect(mappingIssues(session.saves.at(-1))).toEqual([]);
  });

  it('writes a Run input field as a run input read', async () => {
    const session = await openEditor(direct(), {
      handlers: [pinHandler('manual', { customer: 'Ada' })],
    });
    const picker = await openPicker(session);
    await session.event.click(
      await picker.findByRole('button', { name: /^customerAda/u }),
    );
    await session.saved(() => {
      expect(session.savedStep('target')?.inputMappings.customer).toEqual({
        kind: 'run_input',
        path: '$.customer',
      });
    });
  });
});

describe('picking while editing a row', { timeout: 60_000 }, () => {
  const expressionRow = (expression: string) =>
    ({
      greeting: { kind: 'expression', language: 'jsonata', expression },
    }) satisfies GraphNode['inputMappings'];

  async function openRow(session: Session, rowName: RegExp) {
    session.select('Target');
    await session.event.click(
      await screen.findByRole('tab', { name: 'Inputs' }),
    );
    await session.event.click(
      await screen.findByRole('button', { name: rowName }),
    );
  }

  async function pickStatus(session: Session) {
    await session.event.click(
      screen.getByRole('button', { name: 'Insert data' }),
    );
    const picker = within(
      await screen.findByRole('dialog', { name: 'Insert data' }),
    );
    await session.event.click(
      await picker.findByRole('button', { name: /^status/u }),
    );
  }

  it('puts the field at the cursor and keeps the typed text', async () => {
    const session = await openEditor(direct(expressionRow('"a" &  & "b"')), {
      handlers: [pinHandler('fetch', { status: 200 })],
    });
    await openRow(session, /greeting/u);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Expression');
    box.focus();
    box.setSelectionRange(6, 6);
    await pickStatus(session);
    const written = '"a" & nodeOutputs."fetch"."status" & "b"';
    await waitFor(() => {
      expect(box.value).toBe(written);
    });
    await session.saved(() => {
      expect(session.savedStep('target')?.inputMappings.greeting).toEqual(
        expressionRow(written).greeting,
      );
    });
    await expect(
      evaluator.evaluate({
        expression: written,
        context: { runInput: {}, nodeOutputs: { fetch: { status: 200 } } },
      }),
    ).resolves.toMatchObject({ value: 'a200b' });
  });

  it('replaces only the selected part of the expression', async () => {
    const session = await openEditor(direct(expressionRow('"a" & OLD & "b"')), {
      handlers: [pinHandler('fetch', { status: 200 })],
    });
    await openRow(session, /greeting/u);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Expression');
    box.focus();
    box.setSelectionRange(6, 9);
    await pickStatus(session);
    await waitFor(() => {
      expect(box.value).toBe('"a" & nodeOutputs."fetch"."status" & "b"');
    });
  });

  it('still replaces the source of any other kind of open row', async () => {
    const session = await openEditor(
      direct({ greeting: { kind: 'literal', value: 'old value' } }),
      { handlers: [pinHandler('fetch', { status: 200 })] },
    );
    await openRow(session, /greeting/u);
    const value = await screen.findByDisplayValue(/old value/u);
    value.focus();
    await pickStatus(session);
    await session.saved(() => {
      expect(session.savedStep('target')?.inputMappings.greeting).toEqual({
        kind: 'node_output',
        nodeId: 'fetch',
        path: '$.status',
      });
    });
  });
});
