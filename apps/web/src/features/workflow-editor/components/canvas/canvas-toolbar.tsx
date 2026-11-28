import type { RefObject } from 'react';
import { NoteTools } from './notes/tools';
import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { ListTreeIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { cn } from '@/lib/class-names';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { useEditorStoreApi } from '../../model/state/context';
import { tidyLanePositions } from '../../model/graph/lanes';
import { moveWorkflowNodes } from '../../model/graph/workflow-graph-commands';

/**
 * The canvas's own toolbar, bottom centre from 1024px: add a step (or
 * press /), tidy the branches into lanes, fit, and the zoom. Smaller
 * screens keep the zoom lens and the panel buttons instead.
 */
export function CanvasToolbar({
  editable,
  containerRef,
  onAddStep,
  onFit,
}: Readonly<{
  editable: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  onAddStep: () => void;
  onFit: () => void;
}>) {
  const { zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const duration = usePrefersReducedMotion() ? 0 : 200;

  return (
    <Panel
      position="bottom-center"
      aria-label="Canvas toolbar"
      role="toolbar"
      className={cn(
        'lens !left-[calc((100%_+_var(--editor-left-inset)_-_var(--editor-right-inset))/2)] !m-0 !mb-3 flex items-center gap-1 rounded-xl p-1 max-lg:!right-3 max-lg:!bottom-16 max-lg:!left-auto max-lg:!translate-x-0',
        !editable && 'max-lg:hidden',
      )}
    >
      <div className="hidden items-center gap-1 lg:flex">
        {editable ? (
          <>
            <Button type="button" size="sm" onClick={onAddStep}>
              Add a step
              <Kbd>/</Kbd>
            </Button>
            <TidyLanesButton onFit={onFit} />
          </>
        ) : null}
        {/* The same name as the zoom lens's fit below 1024px. */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Fit workflow to screen"
          onClick={onFit}
        >
          Fit
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => void zoomOut({ duration })}
        >
          <MinusIcon />
        </Button>
        <output
          aria-label="Zoom"
          className="w-11 text-center font-mono text-caption text-subtle-foreground"
        >
          {Math.round(zoom * 100)}%
        </output>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Zoom in"
          onClick={() => void zoomIn({ duration })}
        >
          <PlusIcon />
        </Button>
      </div>
      {editable ? (
        <NoteTools editable={editable} containerRef={containerRef} />
      ) : null}
    </Panel>
  );
}

export function TidyLanesButton({
  onFit,
  compact = false,
}: Readonly<{ onFit: () => void; compact?: boolean }>) {
  const store = useEditorStoreApi();

  function tidy() {
    const state = store.getState();
    state.transact(
      moveWorkflowNodes(state.graph, tidyLanePositions(state.graph)),
    );
    // Frame the tidied workflow once React Flow has drawn it.
    requestAnimationFrame(onFit);
  }

  return (
    <Button
      type="button"
      size={compact ? 'icon-xs' : 'sm'}
      variant="ghost"
      aria-label={compact ? 'Tidy lanes' : undefined}
      title={compact ? 'Tidy lanes' : undefined}
      onClick={tidy}
    >
      {compact ? <ListTreeIcon /> : 'Tidy lanes'}
    </Button>
  );
}
