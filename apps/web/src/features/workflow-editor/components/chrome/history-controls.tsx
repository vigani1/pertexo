import { KeyboardIcon, Redo2Icon, Undo2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import type { EditorState } from '../../model/state/store';
import { useEditorStore } from '../../model/state/context';
import { shortcut } from '@/lib/shortcut-keys';

const canUndo = (state: EditorState) =>
  state.history.past.length > 0 && state.save.status !== 'conflict';
const canRedo = (state: EditorState) =>
  state.history.future.length > 0 && state.save.status !== 'conflict';

/** Undo and redo for the draft; the history holds whole edits, not keys. */
export function HistoryControls({
  onUndo,
  onRedo,
  className,
}: Readonly<{ onUndo: () => void; onRedo: () => void; className?: string }>) {
  const undoable = useEditorStore(canUndo);
  const redoable = useEditorStore(canRedo);
  return (
    <div className={cn('flex items-center', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Undo"
        title={`Undo (${shortcut('Z')})`}
        disabled={!undoable}
        onClick={onUndo}
      >
        <Undo2Icon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Redo"
        title={`Redo (${shortcut('Z', { shift: true })})`}
        disabled={!redoable}
        onClick={onRedo}
      >
        <Redo2Icon />
      </Button>
    </div>
  );
}

/**
 * The editor's entries in the workflow's shared phone menu.
 */
export function HistoryMenuItems({
  onUndo,
  onRedo,
  onShowShortcuts,
}: Readonly<{
  onUndo: () => void;
  onRedo: () => void;
  onShowShortcuts: () => void;
}>) {
  const undoable = useEditorStore(canUndo);
  const redoable = useEditorStore(canRedo);
  return (
    <>
      <DropdownMenuItem disabled={!undoable} onClick={onUndo}>
        <Undo2Icon aria-hidden="true" />
        <span className="flex-1">Undo</span>
        <Kbd>{shortcut('Z')}</Kbd>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!redoable} onClick={onRedo}>
        <Redo2Icon aria-hidden="true" />
        <span className="flex-1">Redo</span>
        <Kbd>{shortcut('Z', { shift: true })}</Kbd>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onShowShortcuts}>
        <KeyboardIcon aria-hidden="true" />
        <span className="flex-1">Keyboard shortcuts</span>
        <Kbd>?</Kbd>
      </DropdownMenuItem>
    </>
  );
}
