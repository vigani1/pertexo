import type { KeyboardEvent } from 'react';
import {
  WORKFLOW_NOTE_LIMITS as limits,
  type WorkflowNote,
} from '@pertexo/workflow-model';
import { boundedNotePosition } from '../../../model/notes/commands';
import type { useNoteActions } from './use-actions';

const arrowDeltas: Readonly<
  Record<string, { x: number; y: number } | undefined>
> = {
  ArrowLeft: { x: -10, y: 0 },
  ArrowRight: { x: 10, y: 0 },
  ArrowUp: { x: 0, y: -10 },
  ArrowDown: { x: 0, y: 10 },
};

export function noteKeyDown(
  {
    note,
    editable,
    actions,
    onEdit,
  }: Readonly<{
    note: WorkflowNote;
    editable: boolean;
    actions: ReturnType<typeof useNoteActions>;
    onEdit: () => void;
  }>,
  event: KeyboardEvent<HTMLElement>,
) {
  if (!editable) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    event.stopPropagation();
    actions.remove(note);
    return;
  }
  const duplicateRequested =
    (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd';
  if (duplicateRequested) {
    event.preventDefault();
    event.stopPropagation();
    actions.add({
      ...note,
      id: crypto.randomUUID(),
      position: boundedNotePosition({
        x: note.position.x + 24,
        y: note.position.y + 24,
      }),
    });
    return;
  }
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    onEdit();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.closest<HTMLElement>('[data-workflow-canvas]')?.focus();
    return;
  }
  const delta = arrowDeltas[event.key];
  if (delta === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.shiftKey)
    actions.update({
      ...note,
      size: {
        width: Math.max(
          limits.minWidth,
          Math.min(limits.maxSize, note.size.width + delta.x),
        ),
        height: Math.max(
          limits.minHeight,
          Math.min(limits.maxSize, note.size.height + delta.y),
        ),
      },
    });
  else
    actions.update({
      ...note,
      position: boundedNotePosition({
        x: note.position.x + delta.x,
        y: note.position.y + delta.y,
      }),
    });
}
