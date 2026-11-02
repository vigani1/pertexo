import { Toast } from '@base-ui/react/toast';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it } from 'vitest';
import { useNoteActions } from '@/features/workflow-editor/components/canvas/notes/use-actions';
import { EditorStoreContext } from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';

const step = {
  id: 'step-1',
  definition: { key: 'test.step', version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x: 0, y: 0 },
};

const note = {
  id: '00000000-0000-4000-8000-000000000001',
  text: '',
  position: { x: 20, y: 30 },
  size: { width: 320, height: 200 },
  color: 'teal' as const,
};

function storeWithStepOpen(scratch: boolean) {
  const store = createEditorStore({
    graph: { nodes: [step], edges: [], settings: {}, notes: [] },
    etag: 'opaque',
    revision: 1,
  });
  store.getState().selectNodes(['step-1']);
  store.getState().setInspectorScratch(scratch);
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <Toast.Provider>
      <EditorStoreContext value={store}>{children}</EditorStoreContext>
    </Toast.Provider>
  );
  return { store, ...renderHook(useNoteActions, { wrapper }) };
}

it('adds a note without closing a step that has an unfinished edit', () => {
  const { store, result } = storeWithStepOpen(true);
  expect(result.current.add(note)).toBe(true);
  expect(store.getState().graph.notes).toHaveLength(1);
  expect(store.getState().inspectorScratch).toBe(true);
  expect(store.getState().selectedNodeIds).toEqual(['step-1']);
});

it('clears the selection as before when nothing is unfinished', () => {
  const { store, result } = storeWithStepOpen(false);
  expect(result.current.add(note)).toBe(true);
  expect(store.getState().selectedNodeIds).toEqual([]);
});
