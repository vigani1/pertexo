import { fireEvent, render, screen } from '@testing-library/react';
import { Toast } from '@base-ui/react/toast';
import { describe, expect, it, vi } from 'vitest';
import type { NodeProps } from '@xyflow/react';
import type { WorkflowNote } from '@pertexo/workflow-model';
import { CanvasNote } from '@/features/workflow-editor/components/canvas/notes/card';
import type { NoteFlowNode } from '@/features/workflow-editor/components/canvas/notes/types';
import { EditorStoreContext } from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';

vi.mock('@xyflow/react', () => ({ NodeResizer: () => null }));

const note: WorkflowNote = {
  id: '00000000-0000-4000-8000-000000000001',
  text: '',
  position: { x: 20, y: 30 },
  size: { width: 320, height: 200 },
  color: 'teal',
};
function renderNote(editable = true) {
  const store = createEditorStore({
    graph: { nodes: [], edges: [], settings: {}, notes: [note] },
    etag: 'opaque',
    revision: 1,
  });
  const props: NodeProps<NoteFlowNode> = {
    id: note.id,
    type: 'note',
    data: { note, editable },
    selected: false,
    dragging: false,
    isConnectable: false,
    selectable: true,
    deletable: true,
    draggable: true,
    zIndex: 0,
    positionAbsoluteX: 20,
    positionAbsoluteY: 30,
  };
  render(
    <Toast.Provider>
      <EditorStoreContext value={{ store }}>
        <CanvasNote {...props} />
      </EditorStoreContext>
    </Toast.Provider>,
  );
  return store;
}

describe('canvas note keyboard gestures', () => {
  it.each([
    ['ArrowLeft', { x: 10, y: 30 }],
    ['ArrowRight', { x: 30, y: 30 }],
    ['ArrowUp', { x: 20, y: 20 }],
    ['ArrowDown', { x: 20, y: 40 }],
  ])('moves with %s as one undoable edit', (key, position) => {
    const store = renderNote();
    fireEvent.keyDown(screen.getByRole('article', { name: 'Canvas note' }), {
      key,
    });
    expect(store.getState().graph.notes?.[0]?.position).toEqual(position);
    expect(store.getState().graph.notes?.[0]?.size).toEqual(note.size);
    store.getState().undo();
    expect(store.getState().graph.notes).toEqual([note]);
  });
  it('resizes with Shift without moving and ignores arrows from child controls', () => {
    const store = renderNote();
    fireEvent.keyDown(screen.getByRole('article'), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    expect(store.getState().graph.notes?.[0]).toEqual({
      ...note,
      size: { width: 330, height: 200 },
    });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Edit note' }), {
      key: 'ArrowDown',
    });
    expect(store.getState().graph.notes?.[0]?.position).toEqual(note.position);
  });
  it('leaves read-only notes unchanged', () => {
    const store = renderNote(false);
    fireEvent.keyDown(screen.getByRole('article'), { key: 'ArrowLeft' });
    expect(store.getState().graph.notes).toEqual([note]);
  });
});
