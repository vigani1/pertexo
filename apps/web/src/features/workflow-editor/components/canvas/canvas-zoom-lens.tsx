import { MiniMap, Panel, useReactFlow } from '@xyflow/react';
import { MaximizeIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
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

const MINIMAP_SIZE = Object.freeze({ width: 120, height: 60 });

/** A step on the overview map, in its family's colour. */
function minimapNodeFill(node: WorkflowFlowNode): string {
  return familyFill[node.data.family];
}

/**
 * A small lens with the overview map and zoom controls. Colours come from
 * tokens, never hard-coded values; each step is drawn in its family colour
 * and the selected one is outlined.
 */
export function CanvasZoomLens({ onFit }: Readonly<{ onFit: () => void }>) {
  const { zoomIn, zoomOut } = useReactFlow();
  const reducedMotion = usePrefersReducedMotion();
  const duration = reducedMotion ? 0 : 200;
  return (
    <Panel
      position="bottom-left"
      className="lens !bottom-3 !left-3 !m-0 flex items-center gap-2 rounded-md p-1.5 lg:!left-[var(--editor-left-inset,0.75rem)]"
    >
      <MiniMap<WorkflowFlowNode>
        pannable
        zoomable
        ariaLabel="Workflow overview"
        // The map sizes its drawing from these numbers, not from classes.
        style={MINIMAP_SIZE}
        nodeBorderRadius={3}
        nodeColor={minimapNodeFill}
        nodeStrokeColor={(node) =>
          node.selected === true ? 'var(--primary)' : 'transparent'
        }
        nodeStrokeWidth={14}
        // Pixels; React Flow scales it to the map (the CSS variable isn't).
        maskStrokeWidth={1}
        className="!static !m-0 !hidden overflow-hidden rounded-sm [--xy-minimap-background-color:color-mix(in_srgb,var(--background)_45%,transparent)] [--xy-minimap-mask-background-color:color-mix(in_srgb,var(--background)_55%,transparent)] [--xy-minimap-mask-stroke-color:color-mix(in_srgb,var(--primary)_55%,transparent)] [--xy-minimap-node-background-color:color-mix(in_srgb,var(--accent-foreground)_35%,transparent)] sm:!block"
      />
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          onClick={() => void zoomIn({ duration })}
        >
          <PlusIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => void zoomOut({ duration })}
        >
          <MinusIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Fit workflow to screen"
          onClick={onFit}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </Panel>
  );
}
