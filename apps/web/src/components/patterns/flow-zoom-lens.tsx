import { MiniMap, Panel, useReactFlow, type Node } from '@xyflow/react';
import type { ReactNode } from 'react';
import { MaximizeIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/class-names';
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
  controlsClassName,
  fitClassName,
  children,
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
  /** Hides the zoom buttons where the graph has its own toolbar. */
  controlsClassName?: string;
  fitClassName?: string;
  /** Graph-specific actions beside the compact zoom controls. */
  children?: ReactNode;
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
          className="!static !m-0 !hidden overflow-hidden rounded-sm flow-minimap sm:!block"
        />
      ) : null}
      <div className={cn('flex flex-col gap-1', controlsClassName)}>
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
          className={fitClassName}
          onClick={() => {
            if (onFit === undefined) void fitView({ padding: 0.12, duration });
            else onFit();
          }}
        >
          <MaximizeIcon />
        </Button>
        {children}
      </div>
    </Panel>
  );
}
