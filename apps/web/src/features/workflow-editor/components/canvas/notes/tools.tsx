import { noteTextStart } from '@/features/workflow-drafts/public';
import { noteElementId } from './types';
import { useState, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ListIcon, StickyNoteIcon } from 'lucide-react';
import {
  WORKFLOW_NOTE_LIMITS as limits,
  type WorkflowNote,
} from '@pertexo/workflow-model';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useEditorStore } from '../../../model/state/context';
import {
  CANVAS_COVER_ATTRIBUTE,
  uncoveredArea,
  inset,
  revealedViewport,
} from '../../../model/canvas/framing';
import { boundedNotePosition } from '../../../model/notes/commands';
import { NoteForm } from './form';
import { useNoteActions } from './use-actions';

type NoteToolsProps = Readonly<{
  editable: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
}>;

export function NoteTools({ editable, containerRef }: NoteToolsProps) {
  const notes = useEditorStore((state) => state.graph.notes);
  const count = notes?.length ?? 0;
  const [candidate, setCandidate] =
    useState<Readonly<{ note: WorkflowNote; mode: 'add' | 'edit' }>>();
  const flow = useReactFlow();
  const actions = useNoteActions();
  if (!editable) return null;
  function add() {
    const canvas = containerRef.current?.getBoundingClientRect();
    if (canvas === undefined) return;
    const covers = [
      ...document.querySelectorAll(`[${CANVAS_COVER_ATTRIBUTE}]`),
    ].map((element) => element.getBoundingClientRect());
    const area = uncoveredArea(canvas, covers);
    const centre = flow.screenToFlowPosition({
      x: canvas.left + area.x + area.width / 2,
      y: canvas.top + area.y + area.height / 2,
    });
    const nodes = flow.getNodes();
    const bounds = flow.getNodesBounds(nodes);
    setCandidate({
      mode: 'add',
      note: {
        id: crypto.randomUUID(),
        text: '',
        position: boundedNotePosition({
          x: centre.x - limits.defaultWidth / 2,
          y:
            nodes.length === 0
              ? centre.y - limits.defaultHeight / 2
              : Math.max(
                  centre.y - limits.defaultHeight / 2,
                  bounds.y + bounds.height + 32,
                ),
        }),
        size: { width: limits.defaultWidth, height: limits.defaultHeight },
        color: 'neutral',
      },
    });
  }
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className="lens pointer-events-auto relative z-20 flex w-fit items-center gap-1 rounded-lg p-1"
      {...{ [CANVAS_COVER_ATTRIBUTE]: '' }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Add note"
              disabled={count >= limits.count}
              onClick={add}
            />
          }
        >
          <StickyNoteIcon data-icon="inline-start" />
          Add note
        </TooltipTrigger>
        <TooltipContent>
          {count >= limits.count
            ? `The canvas has ${String(limits.count)} notes. Remove one to add another.`
            : 'Add a canvas note'}
        </TooltipContent>
      </Tooltip>
      {count === 0 ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Canvas notes"
              />
            }
          >
            <ListIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" className="max-w-72">
            {(notes ?? []).map((note) => (
              <DropdownMenuItem
                key={note.id}
                onClick={() => {
                  setCandidate({ note, mode: 'edit' });
                }}
                className="min-h-11"
              >
                <StickyNoteIcon aria-hidden="true" />
                <span className="truncate">
                  {noteTextStart(note.text) || 'Untitled note'}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {candidate === undefined ? null : (
        <NoteForm
          key={candidate.note.id}
          note={candidate.note}
          onClose={() => {
            setCandidate(undefined);
          }}
          {...(candidate.mode === 'edit'
            ? {
                onRemove: () => {
                  actions.remove(candidate.note);
                  setCandidate(undefined);
                },
              }
            : {})}
          onApply={(note) => {
            if (candidate.mode === 'edit') {
              actions.update(note);
              setCandidate(undefined);
            } else if (actions.add(note)) {
              setCandidate(undefined);
              const canvas = containerRef.current?.getBoundingClientRect();
              if (canvas !== undefined) {
                const covers = [
                  ...document.querySelectorAll(`[${CANVAS_COVER_ATTRIBUTE}]`),
                ].map((element) => element.getBoundingClientRect());
                const next = revealedViewport(
                  { ...note.position, ...note.size },
                  inset(uncoveredArea(canvas, covers), 24),
                  flow.getViewport(),
                );
                if (next !== undefined)
                  void flow.setViewport(next, { duration: 0 });
              }
              window.requestAnimationFrame(() =>
                document.getElementById(noteElementId(note.id))?.focus(),
              );
            }
          }}
        />
      )}
    </div>
  );
}
