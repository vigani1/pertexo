import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SaveState } from '@/features/workflow-editor/components/chrome/save-state';
import { EditorStoreContext } from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';

it('announces save outcomes and keeps recovery actions with their owner', async () => {
  const graph = { nodes: [], edges: [], settings: {} };
  const store = createEditorStore({ graph, etag: 'draft-1', revision: 1 });
  const retry = vi.fn();
  const review = vi.fn();
  const user = userEvent.setup();
  render(
    <EditorStoreContext value={store}>
      <SaveState onRetry={retry} onReview={review} />
    </EditorStoreContext>,
  );
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Saved');
  act(() => {
    store.getState().setInspectorScratch(true);
  });
  expect(status).toHaveTextContent('Unsaved');
  act(() => {
    store.getState().setInspectorScratch(false);
    store.getState().beginSave();
  });
  expect(status).toHaveTextContent('Saving…');
  act(() => {
    store.getState().reportFailure('Your changes are still here.', false);
  });
  expect(status).toHaveTextContent('Couldn’t save');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
  act(() => {
    store.getState().reportFailure('The response was lost.', true);
  });
  expect(status).toHaveTextContent('Save unconfirmed');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledTimes(2);
  act(() => {
    store.getState().reportConflict({
      local: graph,
      remote: graph,
      remoteEtag: 'draft-2',
      remoteRevision: 2,
    });
  });
  expect(status).toHaveTextContent('Changed elsewhere');
  await user.click(screen.getByRole('button', { name: 'Review' }));
  expect(review).toHaveBeenCalledOnce();
});

it('says unsaved work waits for the connection while offline', () => {
  const graph = { nodes: [], edges: [], settings: {} };
  const store = createEditorStore({ graph, etag: 'draft-1', revision: 1 });
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  render(
    <EditorStoreContext value={store}>
      <SaveState onRetry={vi.fn()} onReview={vi.fn()} />
    </EditorStoreContext>,
  );
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Saved');
  act(() => {
    store.getState().reportFailure('The response was lost.', true);
  });
  expect(status).toHaveTextContent('Offline · changes kept');
  expect(
    screen.queryByRole('button', { name: 'Retry' }),
  ).not.toBeInTheDocument();
  online.mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  expect(status).toHaveTextContent('Save unconfirmed');
});
