import type { RefObject } from 'react';
import type { useLastRun } from '../../hooks/use-last-run';
import { LastRunLine } from './last-run-line';
import { NoteTools } from './notes/tools';

/** What sits above the canvas: the note tools and the last run's line. */
export function CanvasTools({
  editable,
  canvasRef,
  lastRun,
}: Readonly<{
  editable: boolean;
  canvasRef: RefObject<HTMLDivElement | null>;
  lastRun: ReturnType<typeof useLastRun>;
}>) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <NoteTools editable={editable} containerRef={canvasRef} />
      <LastRunLine
        overlay={lastRun.overlay}
        shown={lastRun.shown}
        onToggle={lastRun.toggle}
      />
    </div>
  );
}
