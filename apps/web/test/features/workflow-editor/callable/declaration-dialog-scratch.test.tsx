import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { DialogTrigger } from '@/components/ui/dialog';
import { DeclarationDialog } from '@/features/workflow-editor/components/callable/declaration-dialog';
import { EditorStoreContext } from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';

it('leaves an unfinished inspector edit alone: no prompt, and it still holds publishing', async () => {
  const user = userEvent.setup();
  const store = createEditorStore({
    graph: { nodes: [], edges: [], settings: {} },
    etag: 'opaque',
    revision: 1,
  });
  store.getState().setInspectorScratch(true);
  render(
    <EditorStoreContext value={store}>
      <DeclarationDialog editable>
        <DialogTrigger>Open contract</DialogTrigger>
      </DeclarationDialog>
    </EditorStoreContext>,
  );
  await user.click(screen.getByRole('button', { name: 'Open contract' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Workflow contract',
  });
  expect(dialog).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByText('Discard contract changes?')).toBeNull();
  expect(store.getState().inspectorScratch).toBe(true);
});

it('takes its Discard prompt from its own edits, and discarding them leaves the inspector holding publishing', async () => {
  const user = userEvent.setup();
  const store = createEditorStore({
    graph: { nodes: [], edges: [], settings: {} },
    etag: 'opaque',
    revision: 1,
  });
  store.getState().setInspectorScratch(true);
  render(
    <EditorStoreContext value={store}>
      <DeclarationDialog editable>
        <DialogTrigger>Open contract</DialogTrigger>
      </DeclarationDialog>
    </EditorStoreContext>,
  );
  await user.click(screen.getByRole('button', { name: 'Open contract' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Workflow contract',
  });
  await user.click(
    within(dialog).getByRole('checkbox', {
      name: 'Declare a callable contract',
    }),
  );
  await user.keyboard('{Escape}');
  await user.click(
    await screen.findByRole('button', { name: 'Discard changes' }),
  );
  await waitFor(() => {
    expect(screen.queryByText('Discard contract changes?')).toBeNull();
  });
  expect(store.getState().inspectorScratch).toBe(true);
});
