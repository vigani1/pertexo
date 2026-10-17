import { createRef } from 'react';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type {
  DataTableDefinition,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import type { DataTableBindings } from '@pertexo/node-sdk';
import { TableColumnNames } from '@/features/workflow-editor/components/inspector/data-tables/column-names';
import {
  EditorStoreContext,
  useEditorStore,
} from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';
import { updateWorkflowNode } from '@/features/workflow-editor/model/graph/commands';
import type { NodeFormApi } from '@/features/workflow-editor/model/inspector/node-form';
import { step, link } from '../../../support/fixtures/for-each';
const amountColumn = {
  id: 'amount',
  name: 'amount',
  type: 'number',
  required: false,
} as const;
const table: DataTableDefinition = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Orders',
  columns: [{ id: 'amount', name: 'amount', type: 'number', required: false }],
  keyColumn: null,
  hasRemovedColumns: false,
  rowCount: 0,
  storedBytes: 0,
  revision: 1,
};
function setup(editable = true) {
  const graph: WorkflowGraphContract = {
    nodes: [
      {
        ...step('table', 'Find'),
        config: { table: 'Orders', columnBindings: { amount: 'amount' } },
        inputMappings: {
          query: {
            kind: 'literal',
            value: {
              filters: [{ column: 'amount', operator: 'equals', value: 1 }],
            },
          },
        },
      },
      step('after', 'After'),
    ],
    edges: [link('next', 'table', 'after')],
    settings: {},
  };
  const store = createEditorStore({ graph, etag: '"draft"', revision: 1 });
  const commit = vi.fn<NodeFormApi['commit']>((update, key) => {
    const current = store.getState();
    const node = current.graph.nodes[0];
    if (node === undefined) throw new Error('Table step missing');
    current.transact(
      updateWorkflowNode(
        current.graph,
        node.id,
        typeof update === 'function' ? update(node) : update,
      ),
      { coalesceKey: key },
    );
  });
  const returnFocus = createRef<HTMLButtonElement>();
  function Harness({
    definition,
  }: Readonly<{ definition: DataTableDefinition }>) {
    const config = useEditorStore((state) => state.graph.nodes[0]?.config);
    return (
      <>
        <TableColumnNames
          table={definition}
          bindings={config?.columnBindings as DataTableBindings | undefined}
          form={{ nodeId: 'table', editable, commit, reportScratch: vi.fn() }}
          returnFocus={returnFocus}
        />
        <button ref={returnFocus}>Review current columns</button>
      </>
    );
  }
  const view = (definition: DataTableDefinition) => (
    <EditorStoreContext value={store}>
      <Harness definition={definition} />
    </EditorStoreContext>
  );
  const rendered = render(view(table));
  return {
    store,
    commit,
    user: userEvent.setup(),
    refresh: (definition: DataTableDefinition) => {
      rendered.rerender(view(definition));
    },
    graph,
  };
}
it.each(['table', 'draft'])(
  'never saves on refresh/cancel and refuses a stale %s review',
  async (changed) => {
    const { store, commit, user, refresh, graph } = setup();
    const renamed = {
      ...table,
      columns: [{ ...amountColumn, name: 'total' }],
      revision: 2,
    };
    refresh(renamed);
    expect(screen.getByText('amount (now called total)')).toBeVisible();
    expect(commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use the new name' }));
    const dialog = within(
      screen.getByRole('dialog', { name: 'Review column names' }),
    );
    if (changed === 'table')
      refresh({
        ...renamed,
        columns: [{ ...amountColumn, name: 'sum' }],
        revision: 3,
      });
    else
      act(() => {
        store.getState().transact(
          updateWorkflowNode(store.getState().graph, 'after', {
            label: 'Changed',
          }),
        );
      });
    expect(
      dialog.getByRole('button', { name: 'Use the new name' }),
    ).toBeDisabled();
    expect(dialog.getByText(/changed during this review/u)).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use the new name' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Use the new name',
      }),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(store.getState().graph.nodes[0]?.config.columnBindings).toEqual(
      changed === 'table' ? { sum: 'amount' } : { total: 'amount' },
    );
    expect(store.getState().graph.nodes[0]?.inputMappings).toEqual(
      graph.nodes[0]?.inputMappings,
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Review current columns' }),
      ).toHaveFocus();
    });
  },
);
it('shows renamed fields but keeps adoption disabled for a reader', () => {
  const { refresh, commit } = setup(false);
  refresh({
    ...table,
    columns: [{ ...amountColumn, name: 'total' }],
    revision: 2,
  });
  expect(screen.getByText('amount (now called total)')).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Use the new name' }),
  ).toBeDisabled();
  expect(commit).not.toHaveBeenCalled();
});
