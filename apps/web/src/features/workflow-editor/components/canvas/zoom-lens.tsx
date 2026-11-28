import type { CanvasFlowNode } from './notes/canvas-note-identity';
import { FlowZoomLens } from '@/components/patterns/flow-zoom-lens';
import { useEditorStore } from '../../model/state/context';
import { TidyLanesButton } from './canvas-toolbar';

/**
 * An overview of the canvas, with a ring around the selected step; below
 * 1024px it also zooms and fits.
 */
export function CanvasZoomLens({
  editable,
  onFit,
}: Readonly<{ editable: boolean; onFit: () => void }>) {
  // An empty draft has nothing to map, so no empty frame either.
  const empty = useEditorStore(
    (state) =>
      state.graph.nodes.length === 0 && (state.graph.notes?.length ?? 0) === 0,
  );
  return (
    <FlowZoomLens<CanvasFlowNode>
      mapLabel="Workflow overview"
      fitLabel="Fit workflow to screen"
      showMap={!empty}
      nodeColor={(node) =>
        node.type === 'note'
          ? 'var(--subtle-foreground)'
          : 'var(--muted-foreground)'
      }
      nodeStrokeColor={(node) =>
        (node.selected ?? false) ? 'var(--action)' : 'transparent'
      }
      onFit={onFit}
      className="lg:!left-[var(--editor-left-inset,0.75rem)]"
      // From 1024px the canvas toolbar zooms and fits.
      controlsClassName="lg:hidden"
    >
      {editable ? <TidyLanesButton compact onFit={onFit} /> : null}
    </FlowZoomLens>
  );
}
