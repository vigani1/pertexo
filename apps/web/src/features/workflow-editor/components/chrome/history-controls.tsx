import { Redo2Icon, Undo2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '../../model/editor-store-context';

/** Undo and redo for the draft; the history holds whole edits, not keys. */
export function HistoryControls({
  onUndo,
  onRedo,
}: Readonly<{ onUndo: () => void; onRedo: () => void }>) {
  const canUndo = useEditorStore(
    (state) => state.history.past.length > 0 && state.saveStatus !== 'conflict',
  );
  const canRedo = useEditorStore(
    (state) =>
      state.history.future.length > 0 && state.saveStatus !== 'conflict',
  );
  return (
    <div className="flex items-center">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Undo"
        title="Undo (⌘Z)"
        disabled={!canUndo}
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
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2Icon />
      </Button>
    </div>
  );
}
