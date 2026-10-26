import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PreviewRunSummary,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { CreateFileSetup } from '@/features/workflow-editor/components/inspector/builders/files/create-setup';
import { ReadFileSetup } from '@/features/workflow-editor/components/inspector/builders/files/read-setup';
import {
  LastTestContext,
  type RecordedTest,
} from '@/features/workflow-editor/hooks/use-last-test';
import { updateWorkflowNode } from '@/features/workflow-editor/model/graph/commands';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import {
  EditorStoreContext,
  useEditorStore,
} from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';

const schema = {
  oneOf: [
    { properties: { format: { const: 'json' } } },
    {
      properties: {
        columns: { maxItems: 4998, items: { type: 'string', maxLength: 256 } },
      },
    },
  ],
};

function setup(
  node: Pick<
    WorkflowGraphContract['nodes'][number],
    'definition' | 'config' | 'inputMappings'
  >,
) {
  const graph: WorkflowGraphContract = {
    nodes: [
      {
        id: 'file',
        label: 'File',
        position: { x: 0, y: 0 },
        configVersion: 1,
        connectionRefs: {},
        ...node,
      },
    ],
    edges: [],
    settings: {},
  };
  const store = createEditorStore({ graph, etag: '"draft"', revision: 1 });
  const form: NodeFormApi = {
    nodeId: 'file',
    editable: true,
    reportScratch: vi.fn(),
    commit: (update, key) => {
      const current = store.getState();
      const step = current.graph.nodes[0];
      if (step === undefined) throw new Error('Step missing');
      current.transact(
        updateWorkflowNode(
          current.graph,
          step.id,
          typeof update === 'function' ? update(step) : update,
        ),
        { coalesceKey: key },
      );
    },
  };
  let test: RecordedTest | undefined;
  function Harness() {
    const config = useEditorStore((state) => state.graph.nodes[0]?.config);
    if (config === undefined) return null;
    return (
      <LastTestContext value={test}>
        {node.definition.key === 'core.read_file' ? (
          <ReadFileSetup config={config} form={form} />
        ) : (
          <CreateFileSetup schema={schema} config={config} form={form} />
        )}
      </LastTestContext>
    );
  }
  const view = render(
    <EditorStoreContext value={store}>
      <Harness />
    </EditorStoreContext>,
  );
  return {
    config: () => store.getState().graph.nodes[0]?.config,
    finishTest: (preview: Partial<PreviewRunSummary>) => {
      test = {
        nodeId: 'file',
        generation: store.getState().generation,
        preview: {
          id: '55555555-5555-4555-8555-555555555555',
          workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          draftRevision: 1,
          nodeId: 'file',
          status: 'succeeded',
          disclosure: {
            sideEffectClass: 'safe',
            mayContactProvider: false,
            mayCauseExternalSideEffect: false,
            dryRun: 'not_supported',
          },
          output: null,
          safeErrorCode: null,
          createdAt: '2026-10-26T09:00:00.000Z',
          startedAt: null,
          completedAt: null,
          expiresAt: '2026-11-02T09:00:00.000Z',
          ...preview,
        },
      };
      view.rerender(
        <EditorStoreContext value={store}>
          <Harness />
        </EditorStoreContext>,
      );
    },
  };
}

/** jsdom lays nothing out; give scrollers the widths a narrow panel has. */
function widthsOf(
  widths: Readonly<{ clientWidth: number; scrollWidth: number }>,
) {
  for (const [key, value] of Object.entries(widths))
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => value,
    });
}

afterEach(() => {
  widthsOf({ clientWidth: 0, scrollWidth: 0 });
});

describe('Excel in the file step setups', () => {
  it('reads a sheet named from the last failed test and previews its rows', async () => {
    const user = userEvent.setup();
    const state = setup({
      definition: { key: 'core.read_file', version: 1 },
      config: { format: 'csv', delimiter: ',', convertValues: true },
      inputMappings: {},
    });
    const excel = screen.getByRole('button', { name: 'Excel' });
    expect(screen.getByRole('button', { name: 'CSV' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(excel);
    expect(state.config()).toEqual({
      format: 'xlsx',
      headerRow: 1,
      convertValues: true,
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.getByText(/Test the step to see its first rows/u),
    ).toBeVisible();

    act(() => {
      state.finishTest({
        status: 'failed',
        safeErrorCode: 'execution.file_input',
        errorSummary:
          'The workbook has no sheet with that name. Its sheets: "Q1 2026", "Notes". Enter a name exactly, or leave Sheet empty to read the first visible sheet.',
      });
    });
    await user.click(screen.getByRole('button', { name: 'Use sheet Notes' }));
    expect(state.config()).toMatchObject({ sheet: 'Notes' });
    expect(screen.getByRole('textbox', { name: 'Sheet' })).toHaveValue('Notes');

    act(() => {
      state.finishTest({
        output: {
          kind: 'inline',
          value: [
            { city: 'Oslo', sales: 1240.5 },
            { city: 'Bergen', sales: 980 },
          ],
        },
      });
    });
    const table = screen.getByRole('table', {
      name: 'First rows from the last test',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['city', 'sales']);
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['Oslo', '1240.5', 'Bergen', '980']);
    expect(screen.getByText('2 of 2 rows from the last test.')).toBeVisible();
    expect(screen.queryByText('Before your edits')).toBeNull();

    const headerRow = screen.getByRole('textbox', { name: 'Header row' });
    await user.clear(headerRow);
    await user.type(headerRow, '2');
    expect(state.config()).toMatchObject({ headerRow: 2 });
    expect(screen.getByText('Before your edits')).toBeVisible();

    const sheet = screen.getByRole('textbox', { name: 'Sheet' });
    await user.clear(sheet);
    expect(state.config()).not.toHaveProperty('sheet');
    await user.type(sheet, 'a/b');
    await user.tab();
    expect(screen.getByText(/Sheet names cannot use/u)).toBeVisible();
  });

  it('says so when the sheet has a header row and no rows under it', () => {
    const state = setup({
      definition: { key: 'core.read_file', version: 1 },
      config: { format: 'xlsx', headerRow: 1, convertValues: true },
      inputMappings: {},
    });
    act(() => {
      state.finishTest({ output: { kind: 'inline', value: [] } });
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No rows under the header row')).toBeVisible();
    expect(
      screen.getByText(
        'The last test found the header row and no rows under it.',
      ),
    ).toBeVisible();
  });

  it('shows that a wide sheet scrolls sideways', () => {
    widthsOf({ clientWidth: 300, scrollWidth: 620 });
    const state = setup({
      definition: { key: 'core.read_file', version: 1 },
      config: { format: 'xlsx', headerRow: 1, convertValues: true },
      inputMappings: {},
    });
    act(() => {
      state.finishTest({
        output: {
          kind: 'inline',
          value: [{ sku: 'A1', name: 'Bolt', stock: 4, bin: 'C2', price: 1 }],
        },
      });
    });
    const table = screen.getByRole('table', {
      name: 'First rows from the last test',
    });
    expect(table).toHaveAccessibleDescription(
      'Scroll sideways to see more columns.',
    );
    // Keyboard people can reach the hidden columns too.
    expect(table).toHaveAttribute('tabindex', '0');
  });

  it('writes Excel with ordered columns and shows how the sheet starts', async () => {
    const user = userEvent.setup();
    const state = setup({
      definition: { key: 'core.create_file', version: 1 },
      config: { format: 'json' },
      inputMappings: {
        data: {
          kind: 'literal',
          value: [{ currency: 'EUR', amount: 12.5, paid: true }],
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Excel' }));
    expect(state.config()).toEqual({
      format: 'xlsx',
      sheetName: 'Sheet1',
      columns: [],
    });
    expect(
      screen.getByText('All fields, in the order they first appear.'),
    ).toBeVisible();
    const table = screen.getByRole('table', { name: 'How the sheet starts' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['currency', 'amount', 'paid']);

    const add = screen.getByRole('textbox', {
      name: 'Columns, in output order',
    });
    await user.type(add, 'paid{Enter}');
    await user.type(add, 'currency');
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    expect(state.config()).toMatchObject({ columns: ['paid', 'currency'] });
    await user.click(screen.getByRole('button', { name: 'Move currency up' }));
    expect(state.config()).toMatchObject({ columns: ['currency', 'paid'] });
    expect(
      within(screen.getByRole('table', { name: 'How the sheet starts' }))
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['EUR', 'true']);
    await user.type(add, 'paid{Enter}');
    expect(screen.getByText('Choose each column once.')).toBeVisible();
    await user.clear(add);
    await user.click(screen.getByRole('button', { name: 'Remove paid' }));
    expect(state.config()).toMatchObject({ columns: ['currency'] });

    const name = screen.getByRole('textbox', { name: 'Sheet name' });
    await user.clear(name);
    await user.tab();
    expect(screen.getByText('Name the sheet.')).toBeVisible();
    await user.type(name, 'Orders 2026');
    expect(state.config()).toMatchObject({ sheetName: 'Orders 2026' });
  });
});
