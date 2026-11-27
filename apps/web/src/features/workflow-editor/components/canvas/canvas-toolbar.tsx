import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { MinusIcon, PlusIcon } from 'lucide-react';
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
  onAddStep,
  onFit,
}: Readonly<{
  editable: boolean;
  onAddStep: () => void;
  onFit: () => void;
}>) {
  const store = useEditorStoreApi();
  const { zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const duration = usePrefersReducedMotion() ? 0 : 200;

  function tidy() {
    const state = store.getState();
    state.transact(
      moveWorkflowNodes(state.graph, tidyLanePositions(state.graph)),
    );
    // Frame the tidied workflow once React Flow has drawn it.
    requestAnimationFrame(onFit);
  }

  return (
    <Panel
      position="bottom-center"
      aria-label="Canvas toolbar"
      role="toolbar"
      className="lens !m-0 !mb-3 hidden items-center gap-1 rounded-xl p-1 lg:flex"
    >
      {editable ? (
        <>
          <Button type="button" size="sm" onClick={onAddStep}>
            Add a step
            <Kbd>/</Kbd>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={tidy}>
            Tidy lanes
          </Button>
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
    </Panel>
  );
}
