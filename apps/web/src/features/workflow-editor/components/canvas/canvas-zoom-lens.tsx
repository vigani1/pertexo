import { FlowZoomLens } from '@/components/patterns/flow-zoom-lens';
import { useEditorStore } from '../../model/editor-store-context';
import type { WorkflowFlowNode } from '../../model/graph-adapter';

// Family colours, as on the step tiles: trigger cyan, action ice, logic
// lavender, transform mint, output neutral.
const familyFill: Readonly<Record<WorkflowFlowNode['data']['family'], string>> =
  {
    trigger: 'var(--primary)',
    action: 'color-mix(in srgb, var(--accent-foreground) 70%, transparent)',
    logic: 'color-mix(in srgb, var(--secondary) 80%, transparent)',
    transform: 'color-mix(in srgb, var(--success) 75%, transparent)',
    output: 'color-mix(in srgb, var(--muted-foreground) 70%, transparent)',
    unknown: 'color-mix(in srgb, var(--subtle-foreground) 60%, transparent)',
  };

/**
 * The editor's zoom lens: each step on the overview map in its family's
 * colour, the selected one outlined, and fit using the editor's framing.
 */
export function CanvasZoomLens({ onFit }: Readonly<{ onFit: () => void }>) {
  // An empty draft has nothing to map, so no empty frame either.
  const empty = useEditorStore((state) => state.graph.nodes.length === 0);
  return (
    <FlowZoomLens<WorkflowFlowNode>
      mapLabel="Workflow overview"
      fitLabel="Fit workflow to screen"
      showMap={!empty}
      nodeColor={(node) => familyFill[node.data.family]}
      nodeStrokeColor={(node) =>
        node.selected === true ? 'var(--primary)' : 'transparent'
      }
      onFit={onFit}
      className="lg:!left-[var(--editor-left-inset,0.75rem)]"
    />
  );
}
