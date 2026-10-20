import { MiniMap, Panel, useReactFlow, type Node } from '@xyflow/react';
import { MaximizeIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';

const MINIMAP_SIZE = Object.freeze({ width: 120, height: 60 });

/**
 * The one zoom lens for every graph: a small overview map (from `sm` up)
 * beside zoom in, zoom out and fit, bottom left. Each graph colours its own
 * steps and outlines the chosen one; colours come from tokens.
 */
export function FlowZoomLens<NodeType extends Node>({
  mapLabel,
  fitLabel,
  showMap,
  nodeColor,
  nodeStrokeColor,
  onFit,
  className,
}: Readonly<{
  /** Names the overview map: "Workflow overview". */
  mapLabel: string;
  /** Names the fit button: "Fit workflow to screen". */
  fitLabel: string;
  showMap: boolean;
  nodeColor: (node: NodeType) => string;
  nodeStrokeColor: (node: NodeType) => string;
  /** Replaces the plain fit, e.g. with the editor's own framing. */
  onFit?: () => void;
  className?: string;
}>) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const reducedMotion = usePrefersReducedMotion();
  const duration = reducedMotion ? 0 : 200;
  return (
    <Panel
      position="bottom-left"
      className={cn(
        'lens !bottom-3 !left-3 !m-0 flex items-center gap-2 rounded-md p-1.5',
        className,
      )}
    >
      {showMap ? (
        <MiniMap<NodeType>
          pannable
          zoomable
          ariaLabel={mapLabel}
          // The map sizes its drawing from these numbers, not from classes.
          style={MINIMAP_SIZE}
          nodeBorderRadius={3}
          nodeColor={nodeColor}
          nodeStrokeColor={nodeStrokeColor}
          nodeStrokeWidth={14}
          // Pixels; React Flow scales it to the map (the CSS variable isn't).
          maskStrokeWidth={1}
          className="!static !m-0 !hidden overflow-hidden rounded-sm [--xy-minimap-background-color:color-mix(in_srgb,var(--background)_45%,transparent)] [--xy-minimap-mask-background-color:color-mix(in_srgb,var(--background)_55%,transparent)] [--xy-minimap-mask-stroke-color:color-mix(in_srgb,var(--primary)_55%,transparent)] [--xy-minimap-node-background-color:color-mix(in_srgb,var(--accent-foreground)_35%,transparent)] sm:!block"
        />
      ) : null}
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
          aria-label={fitLabel}
          onClick={() => {
            if (onFit === undefined) void fitView({ padding: 0.12, duration });
            else onFit();
          }}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </Panel>
  );
}
