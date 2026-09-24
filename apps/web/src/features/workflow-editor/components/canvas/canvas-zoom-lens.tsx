import { MiniMap, Panel, useReactFlow } from '@xyflow/react';
import { MaximizeIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import type { WorkflowFlowNode } from '../../model/graph-adapter';

/**
 * A small lens with the overview map and zoom controls. Colours come from
 * tokens through React Flow's CSS variables, never hard-coded values.
 */
export function CanvasZoomLens() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
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
        nodeBorderRadius={3}
        nodeClassName={(node) =>
          node.selected === true ? '!fill-primary' : ''
        }
        className="!static !m-0 !hidden !h-15 !w-30 overflow-hidden rounded-sm [--xy-minimap-background-color:color-mix(in_srgb,var(--background)_45%,transparent)] [--xy-minimap-mask-background-color:color-mix(in_srgb,var(--background)_55%,transparent)] [--xy-minimap-mask-stroke-color:color-mix(in_srgb,var(--primary)_55%,transparent)] [--xy-minimap-mask-stroke-width:1] [--xy-minimap-node-background-color:color-mix(in_srgb,var(--accent-foreground)_35%,transparent)] sm:!block"
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
          onClick={() => void fitView({ padding: 0.2, duration })}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </Panel>
  );
}
