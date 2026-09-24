import { GitCompareArrowsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { useEditorStore } from '../../model/editor-store-context';

/**
 * A draft conflict never blocks the canvas: an amber bar says what happened
 * and offers Compare, Keep mine (continue from their version with your copy
 * kept beside it) or Load theirs. Nothing overwrites the other person's work.
 */
export function ConflictBar({
  onCompare,
}: Readonly<{ onCompare: () => void }>) {
  const conflict = useEditorStore((state) => state.conflict);
  const inConflict = useEditorStore((state) => state.saveStatus === 'conflict');
  const keepMine = useEditorStore((state) => state.acceptRemoteForReview);
  const loadTheirs = useEditorStore((state) => state.discardLocalAndUseRemote);
  const dismiss = useEditorStore((state) => state.dismissConflictComparison);
  if (conflict === null) return null;
  return (
    <section
      aria-label="Draft conflict"
      className="lens pointer-events-auto mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border-warning/35 px-3 py-2 text-sm"
    >
      <StatusGlyph tone="attention" className="text-warning" />
      <p className="min-w-0 flex-1">
        {inConflict ? (
          <>
            <span className="font-semibold text-warning">
              Changed elsewhere (revision {conflict.remoteRevision})
            </span>
            <span className="text-muted-foreground">
              {' '}
              · Saving is paused until you choose. Both versions are safe.
            </span>
          </>
        ) : (
          <>
            <span className="font-semibold text-warning">
              Your copy is kept for comparison
            </span>
            <span className="text-muted-foreground">
              {' '}
              · You’re editing their version. Re-apply steps from Compare.
            </span>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={onCompare}>
          <GitCompareArrowsIcon data-icon="inline-start" />
          Compare
        </Button>
        {inConflict ? (
          <>
            <Button type="button" size="sm" onClick={keepMine}>
              Keep mine
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={loadTheirs}
            >
              Load theirs
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
            Dismiss copy
          </Button>
        )}
      </div>
    </section>
  );
}
