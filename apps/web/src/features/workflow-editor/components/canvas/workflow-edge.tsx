import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { XIcon } from 'lucide-react';
import { use, useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import type { WorkflowFlowEdge } from '../../model/graph-adapter';
import { CanvasActionsContext } from './canvas-actions-context';

const HIDE_DELAY_MS = 160;
const WEAVE_STEP_MS = 320;

/**
 * A connection is a thread: it brightens on hover, turns cyan when selected
 * and offers ✕ to remove it. Into a step with issues it runs dashed; after a
 * passed test it flows; on publish it weaves in by execution order.
 */
export function WorkflowEdge({
  id,
  data,
  markerEnd,
  selected,
  sourcePosition,
  sourceX,
  sourceY,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<WorkflowFlowEdge>) {
  const { editable, removeEdge } = use(CanvasActionsContext);
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const [path, labelX, labelY] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });
  useEffect(
    () => () => {
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  function show() {
    window.clearTimeout(hideTimer.current);
    setHovered(true);
  }
  function hideSoon() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setHovered(false);
    }, HIDE_DELAY_MS);
  }

  const weaveOrder = data?.weaveOrder ?? null;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        interactionWidth={18}
        className={cn(
          '!stroke-[1.6] transition-[stroke] duration-150 motion-reduce:transition-none',
          data?.intoIssue === true
            ? '!stroke-destructive/70 [stroke-dasharray:4_5]'
            : '!stroke-muted-foreground/35',
          hovered && '!stroke-accent-foreground/75',
          selected === true && '!stroke-primary !stroke-2',
        )}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
      />
      {data?.flowing === true ? (
        <path
          d={path}
          fill="none"
          aria-hidden="true"
          className="pointer-events-none stroke-accent-foreground [stroke-dasharray:2_14] [stroke-width:2] drop-shadow-[0_0_4px_var(--primary)] motion-safe:animate-[editor-edge-flow_1s_linear_infinite]"
        />
      ) : null}
      {weaveOrder === null ? null : (
        <path
          d={path}
          fill="none"
          pathLength={1}
          aria-hidden="true"
          style={
            {
              '--weave-delay': `${String(weaveOrder * WEAVE_STEP_MS + 120)}ms`,
            } as CSSProperties
          }
          className="pointer-events-none stroke-accent-foreground [stroke-dasharray:1] [stroke-dashoffset:1] [stroke-width:2.4] drop-shadow-[0_0_6px_var(--primary)] motion-safe:animate-[editor-weave_0.55s_var(--ease-unspool)_var(--weave-delay)_forwards] motion-reduce:hidden"
        />
      )}
      {editable && (hovered || selected === true) ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label={`Remove connection from ${data?.sourceLabel ?? 'a step'} to ${data?.targetLabel ?? 'a step'}`}
            className="nodrag nopan lens pointer-events-auto absolute grid size-6 place-items-center rounded-full text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5"
            style={{
              transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
            }}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
            onClick={() => {
              removeEdge(id);
            }}
          >
            <XIcon aria-hidden="true" />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
