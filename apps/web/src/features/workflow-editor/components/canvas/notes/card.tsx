import { Suspense, useState } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import {
  GripHorizontalIcon,
  PencilIcon,
  StickyNoteIcon,
  Trash2Icon,
} from 'lucide-react';
import { WORKFLOW_NOTE_LIMITS as limits } from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import { cn } from '@/lib/utils';
import { boundedNotePosition } from '../../../model/notes/commands';
import { NoteForm } from './form';
import { noteKeyDown } from './keyboard';
import { useNoteActions } from './use-actions';
import { noteElementId, type NoteFlowNode } from './types';

const NoteMarkdown = lazyPiece(() =>
  import('./markdown').then((module) => module.NoteMarkdown),
);
const colors = {
  neutral: 'border-border-strong [--note-accent:var(--subtle-foreground)]',
  teal: 'border-primary/45 [--note-accent:var(--primary)]',
  violet: 'border-secondary/45 [--note-accent:var(--secondary)]',
  sage: 'border-success/45 [--note-accent:var(--success)]',
  amber: 'border-warning/45 [--note-accent:var(--warning)]',
};
export function CanvasNote({ data }: NodeProps<NoteFlowNode>) {
  const { note, editable } = data;
  const [editing, setEditing] = useState(false);
  const actions = useNoteActions();
  return (
    <>
      <NodeResizer
        onResizeEnd={(_event, bounds) => {
          actions.update({
            ...note,
            position: boundedNotePosition({ x: bounds.x, y: bounds.y }),
            size: { width: bounds.width, height: bounds.height },
          });
        }}
        isVisible={editable}
        minWidth={limits.minWidth}
        minHeight={limits.minHeight}
        maxWidth={limits.maxSize}
        maxHeight={limits.maxSize}
        handleClassName="!size-3 !rounded-sm !border-background !bg-primary opacity-0 group-hover/canvas-note:opacity-100 group-focus-within/canvas-note:opacity-100"
        lineClassName="!border-primary/50 opacity-0 group-hover/canvas-note:opacity-100 group-focus-within/canvas-note:opacity-100"
      />
      <article
        tabIndex={0}
        aria-label="Canvas note"
        id={noteElementId(note.id)}
        aria-description={
          editable
            ? 'Arrow keys move this note. Shift and arrow keys resize it. Enter edits. Delete removes it.'
            : undefined
        }
        onKeyDown={(event) => {
          noteKeyDown(
            {
              note,
              editable,
              actions,
              onEdit: () => {
                setEditing(true);
              },
            },
            event,
          );
        }}
        className={cn(
          'group/note flex size-full flex-col overflow-hidden rounded-lg border bg-[color-mix(in_srgb,var(--note-accent)_5%,var(--card))] text-card-foreground shadow-sm outline-none focus-ring',
          colors[note.color],
        )}
      >
        <header className="canvas-note-handle flex shrink-0 cursor-grab items-center gap-2 border-b border-border bg-raised/50 px-2 py-1.5 active:cursor-grabbing">
          <StickyNoteIcon
            aria-hidden="true"
            className="size-3.5 text-[var(--note-accent)]"
          />
          <span className="grow text-xs font-semibold text-muted-foreground">
            Note
          </span>
          <GripHorizontalIcon
            aria-hidden="true"
            className="size-4 text-subtle-foreground"
          />
          {editable ? (
            <div className="nodrag flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Edit note"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Delete note"
                onClick={() => {
                  actions.remove(note);
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          ) : null}
        </header>
        <div
          className="nodrag nopan nowheel min-h-0 flex-1 overflow-auto p-3 select-text"
          onDoubleClick={
            editable
              ? () => {
                  setEditing(true);
                }
              : undefined
          }
        >
          {note.text === '' ? (
            <p className="text-sm text-subtle-foreground">
              {editable
                ? 'Add context for this part of the workflow. Choose Edit note to write.'
                : 'No text in this note.'}
            </p>
          ) : (
            <Suspense
              fallback={
                <p className="text-sm whitespace-pre-wrap">{note.text}</p>
              }
            >
              <NoteMarkdown text={note.text} />
            </Suspense>
          )}
        </div>
      </article>
      {editing && editable ? (
        <NoteForm
          key={note.id}
          note={note}
          onClose={() => {
            setEditing(false);
          }}
          onRemove={() => {
            actions.remove(note);
          }}
          onApply={(next) => {
            actions.update(next);
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}
