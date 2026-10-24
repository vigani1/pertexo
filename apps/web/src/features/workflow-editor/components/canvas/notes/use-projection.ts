import { useCallback, useMemo, useState } from 'react';
import type { NodeChange } from '@xyflow/react';
import {
  useEditorStore,
  useEditorStoreApi,
} from '../../../model/state/context';
import { moveWorkflowNotes } from '../../../model/notes/commands';
import {
  noteIdFromFlowId,
  noteFlowId,
  type CanvasFlowNode,
  type NoteFlowNode,
} from './types';

type Point = Readonly<{ x: number; y: number }>;
type Size = Readonly<{ width: number; height: number }>;
export function useNoteProjection({
  editable,
}: Readonly<{ editable: boolean }>) {
  const store = useEditorStoreApi();
  const notes = useEditorStore((state) => state.graph.notes);
  const [dragging, setDragging] = useState<ReadonlyMap<string, Point>>(
    () => new Map(),
  );
  const [resizing, setResizing] = useState<ReadonlyMap<string, Size>>(
    () => new Map(),
  );
  const nodes = useMemo<NoteFlowNode[]>(
    () =>
      (notes ?? []).map((note) => ({
        id: noteFlowId(note.id),
        type: 'note',
        position: dragging.get(note.id) ?? note.position,
        data: { note, editable },
        style: { ...(resizing.get(note.id) ?? note.size) },
        width: resizing.get(note.id)?.width ?? note.size.width,
        height: resizing.get(note.id)?.height ?? note.size.height,
        dragHandle: '.canvas-note-handle',
        draggable: editable,
        connectable: false,
        selectable: false,
        focusable: false,
        zIndex: -1,
        className: 'group/canvas-note',
      })),
    [notes, editable, dragging, resizing],
  );
  const onChanges = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      if (!editable) return;
      const moving = new Map<string, Point>(),
        settled = new Map<string, Point>();
      const sized = new Map<string, Size>(),
        finished = new Set<string>();
      for (const change of changes) {
        if (change.type === 'add' || change.type === 'replace') continue;
        const id = noteIdFromFlowId(change.id);
        if (change.type === 'position' && change.position !== undefined) {
          // React Flow's resize moves have no dragging flag. Only a finished
          // pointer drag commits here; the resizer owns its final rectangle.
          (change.dragging === false ? settled : moving).set(
            id,
            change.position,
          );
        } else if (
          change.type === 'dimensions' &&
          change.resizing !== undefined
        ) {
          if (change.resizing && change.dimensions !== undefined)
            sized.set(id, change.dimensions);
          else if (!change.resizing) finished.add(id);
        }
      }
      if (moving.size > 0)
        setDragging((current) => new Map([...current, ...moving]));
      if (sized.size > 0)
        setResizing((current) => new Map([...current, ...sized]));
      if (settled.size > 0 || finished.size > 0) {
        const state = store.getState();
        state.transact(moveWorkflowNotes(state.graph, settled));
        setDragging(
          (current) =>
            new Map(
              [...current].filter(
                ([id]) => !settled.has(id) && !finished.has(id),
              ),
            ),
        );
        setResizing(
          (current) =>
            new Map([...current].filter(([id]) => !finished.has(id))),
        );
      }
    },
    [editable, store],
  );
  return { nodes, onChanges };
}
