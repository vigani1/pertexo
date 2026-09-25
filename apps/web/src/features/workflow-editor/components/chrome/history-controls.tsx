import { EllipsisIcon, KeyboardIcon, Redo2Icon, Undo2Icon } from 'lucide-react';
import type { Ref } from 'react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import type { EditorState } from '../../model/editor.store';
import { useEditorStore } from '../../model/editor-store-context';

const canUndo = (state: EditorState) =>
  state.history.past.length > 0 && state.saveStatus !== 'conflict';
const canRedo = (state: EditorState) =>
  state.history.future.length > 0 && state.saveStatus !== 'conflict';

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
        title="Undo (⌘Z)"
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
        title="Redo (⇧⌘Z)"
        disabled={!redoable}
        onClick={onRedo}
      >
        <Redo2Icon />
      </Button>
    </div>
  );
}

/**
 * Undo, redo and the shortcut sheet folded into ⋯, so a phone-width
 * command bar keeps room for Run and Publish.
 */
export function CompactHistoryMenu({
  onUndo,
  onRedo,
  onShowShortcuts,
  triggerRef,
  className,
}: Readonly<{
  onUndo: () => void;
  onRedo: () => void;
  onShowShortcuts: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  className?: string;
}>) {
  const undoable = useEditorStore(canUndo);
  const redoable = useEditorStore(canRedo);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label="More editor actions"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          className,
        )}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled={!undoable} onClick={onUndo}>
          <Undo2Icon aria-hidden="true" />
          <span className="flex-1">Undo</span>
          <Kbd>⌘Z</Kbd>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!redoable} onClick={onRedo}>
          <Redo2Icon aria-hidden="true" />
          <span className="flex-1">Redo</span>
          <Kbd>⇧⌘Z</Kbd>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onShowShortcuts}>
          <KeyboardIcon aria-hidden="true" />
          <span className="flex-1">Keyboard shortcuts</span>
          <Kbd>?</Kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
