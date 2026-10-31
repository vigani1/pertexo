import { GitCompareArrowsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { useEditorStore } from '../../model/state/context';
import { shownConflict } from '../../model/state/store';

/**
 * A draft conflict never blocks the canvas: an amber bar says what happened
 * and offers Compare, Keep mine (save your graph over theirs) or Load theirs
 * (replace yours). Nothing is overwritten until you choose.
 */
export function ConflictBar({
  onCompare,
}: Readonly<{ onCompare: () => void }>) {
  const conflict = useEditorStore(shownConflict);
  const keepMine = useEditorStore((state) => state.keepMine);
  const loadTheirs = useEditorStore((state) => state.discardLocalAndUseRemote);
  if (conflict === null) return null;
  return (
    <section
      aria-label="Draft conflict"
      className="lens pointer-events-auto mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border-warning/35 px-3 py-2 text-sm"
    >
      <StatusGlyph tone="attention" className="text-warning" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold text-warning">
          Changed elsewhere (revision {conflict.remoteRevision})
        </span>
        <span className="text-muted-foreground">
          {' '}
          · Saving is paused until you choose. Both versions are safe.
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={onCompare}>
          <GitCompareArrowsIcon data-icon="inline-start" />
          Compare
        </Button>
        <Button type="button" size="sm" onClick={keepMine}>
          Keep mine
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={loadTheirs}>
          Load theirs
        </Button>
      </div>
    </section>
  );
}
