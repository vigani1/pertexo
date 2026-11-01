import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  link,
  openEditor,
  pinHandler,
  step,
  type GraphNode,
} from '../../../../support/fixtures/inspector-session';
import {
  direct,
  formStep,
  mappingIssues,
  openPicker,
  stepTestHandler,
} from './fixture';

describe('what a step lists', { timeout: 60_000 }, () => {
  const ORDER = {
    status: 200,
    paid: true,
    note: null,
    customer: { name: 'Ada', address: { city: 'London' } },
    items: [{ id: 7 }, { id: 8 }],
  };

  it('shows nested fields with their real values and types', async () => {
    const session = await openEditor(direct(), {
      handlers: [pinHandler('fetch', ORDER)],
    });
    const picker = await openPicker(session);
    expect(
      await picker.findByRole('button', { name: 'status200number' }),
    ).toBeVisible();
    expect(
      picker.getByRole('button', { name: 'paidtrueboolean' }),
    ).toBeVisible();
    expect(picker.getByRole('button', { name: 'notenullnull' })).toBeVisible();
    expect(
      picker.getByRole('button', { name: 'customer2 fieldsobject' }),
    ).toBeVisible();
    expect(
      picker.getByRole('button', { name: 'items2 itemsarray' }),
    ).toBeVisible();

    // A step's own fields start open; anything deeper waits to be asked for.
    expect(picker.getByRole('button', { name: 'nameAdastring' })).toBeVisible();
    expect(picker.getByRole('button', { name: 'id7number' })).toBeVisible();
    expect(picker.queryByRole('button', { name: /^cityLondon/u })).toBeNull();
    const expand = picker.getByRole('button', {
      name: 'Show the fields in address',
    });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await session.event.click(expand);
    expect(
      picker.getByRole('button', { name: 'Hide the fields in address' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      picker.getByRole('button', { name: 'cityLondonstring' }),
    ).toBeVisible();
  });

  it('lists a step’s declared fields beside what it really returned', async () => {
    const session = await openEditor(
      {
        nodes: [
          step('manual', 'core.manual', 'Start'),
          step('http', 'http.request', 'Call shop'),
          step('target', 'core.set', 'Target'),
        ],
        edges: [link('manual', 'http'), link('http', 'target')],
        settings: {},
      },
      {
        handlers: [
          pinHandler('http', { status: 200, body: { order: { id: 7 } } }),
        ],
      },
    );
    const picker = await openPicker(session);
    expect(
      await picker.findByRole('button', { name: 'order1 fieldobject' }),
    ).toBeVisible();
  });

  it('says how many more there are beyond 50 fields at a level', async () => {
    const session = await openEditor(direct(), {
      handlers: [
        pinHandler(
          'fetch',
          Object.fromEntries(
            Array.from({ length: 53 }, (_, index) => [
              `field${String(index)}`,
              index,
            ]),
          ),
        ),
      ],
    });
    const picker = await openPicker(session);
    expect(await picker.findByText(/And 3 more/u)).toBeVisible();
  });

  it.each([
    [
      /^Your name/u,
      'name',
      0,
      { kind: 'node_output', nodeId: 'form', path: '$.values.name' },
    ],
    [
      /^Days off/u,
      'days',
      0,
      { kind: 'node_output', nodeId: 'form', path: '$.values.days' },
    ],
    [/^Days off/u, 'days', 1, { kind: 'run_input', path: '$.values.days' }],
  ] as const)(
    'lists a form’s %s before anything has run, and picking it reads the answer',
    async (name, key, listed, source) => {
      const session = await openEditor({
        nodes: [formStep(), step('target', 'core.set', 'Target')],
        edges: [link('form', 'target')],
        settings: {},
      });
      const picker = await openPicker(session);
      expect(
        (await picker.findAllByText('No test data yet.')).length,
      ).toBeGreaterThan(0);
      // Listed under the step itself, and again under Run input.
      const rows = await picker.findAllByRole('button', { name });
      const row = rows[listed];
      if (row === undefined) throw new Error('The field isn’t listed there');
      await session.event.click(row);
      await session.saved(() => {
        expect(session.savedStep('target')?.inputMappings[key]).toEqual(source);
      });
      expect(mappingIssues(session.saves.at(-1))).toEqual([]);
    },
  );

  it('shows a Request input’s questions before anything has run', async () => {
    const session = await openEditor({
      nodes: [
        step('manual', 'core.manual', 'Start'),
        step('ask', 'core.request_input', 'Ask for leave', {
          config: {
            title: 'Leave',
            instructions: '',
            audience: { roles: ['owner'], memberIds: [] },
            fields: formStep().config.fields as readonly unknown[],
          },
        } as Partial<GraphNode>),
        step('target', 'core.set', 'Target'),
      ],
      edges: [link('manual', 'ask'), link('ask', 'target')],
      settings: {},
    });
    const picker = await openPicker(session);
    expect(
      await picker.findByRole('button', { name: /^Days off/u }),
    ).toBeVisible();
  });
});

describe('with no sample yet', { timeout: 60_000 }, () => {
  it('offers to test the step, and that opens its Test tab', async () => {
    const session = await openEditor(direct(), {
      handlers: [stepTestHandler('fetch', { tested: 'Fetch order' })],
    });
    const picker = await openPicker(session);
    expect(
      (await picker.findAllByText('No test data yet.')).length,
    ).toBeGreaterThan(0);
    await session.event.click(
      picker.getByRole('button', {
        name: 'Test Fetch order to see its fields',
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole('tab', { name: 'Test', selected: true }),
      ).toBeVisible();
    });
    // It's that step's Test tab: running it tests Fetch order, not Target.
    await session.event.click(
      screen.getByRole('switch', {
        name: 'I understand this test runs for real',
      }),
    );
    await session.event.click(screen.getByRole('button', { name: 'Run test' }));
    expect(
      await screen.findByRole('region', { name: 'Last test' }),
    ).toBeVisible();
  });
});
