import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeToolbar,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';
import { PlusIcon, XIcon } from 'lucide-react';
import { use, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { TimedOutGlyph } from '@/components/patterns/dates/timed-out-glyph';
import { cn } from '@/lib/class-names';
import type { WorkflowFlowEdge } from '../../model/graph/adapter';
import { CanvasActionsContext } from '../../model/canvas/actions-context';

const HIDE_DELAY_MS = 160;
// Links run square with rounded corners, so branches read as lanes.
const CORNER_RADIUS = 14;
const WEAVE_STEP_MS = 320;
// The thread's own stroke outranks React Flow's focus style, so a link with
// keyboard focus looks selected here.
const FOCUSED_THREAD = String.raw`in-[.react-flow\_\_edge:focus-visible]:!stroke-primary in-[.react-flow\_\_edge:focus-visible]:!stroke-2`;

/**
 * A link is a thread drawn square, lane to lane: it brightens on hover, turns cyan when selected
 * and offers ✕ to remove it. Failure runs red and Timed out amber, each
 * dashed in its own rhythm. Into a step with issues it runs dashed; after a
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
  const { editable } = use(CanvasActionsContext);
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const [path, labelX, labelY] = getSmoothStepPath({
    borderRadius: CORNER_RADIUS,
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

  const look = edgePresentation({ data, selected });
  const { failure, timedOut, flowing, isSelected, weaveOrder, proposed } = look;
  const showActions = editable && !proposed && (hovered || isSelected);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        interactionWidth={18}
        className={edgeClassName(look, hovered)}
      />
      {proposed ? null : (
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={18}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
        />
      )}
      {flowing ? (
        <path
          d={path}
          fill="none"
          aria-hidden="true"
          className="pointer-events-none stroke-accent-foreground [stroke-dasharray:2_14] [stroke-width:2] drop-shadow-live motion-safe:animate-[editor-edge-flow_1s_linear_infinite]"
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
          className="pointer-events-none stroke-accent-foreground [stroke-dasharray:1] [stroke-dashoffset:1] [stroke-width:2.4] drop-shadow-live motion-safe:animate-[editor-weave_0.55s_var(--ease-unspool)_var(--weave-delay)_forwards] motion-reduce:hidden"
        />
      )}
      {failure || timedOut ? (
        <EdgeStatusLabel
          x={labelX}
          y={labelY}
          failure={failure}
          proposed={proposed}
        />
      ) : null}
      {showActions ? (
        <EdgeActions
          id={id}
          x={labelX}
          y={labelY}
          data={data}
          onShow={show}
          onHide={hideSoon}
        />
      ) : null}
    </>
  );
}

function edgePresentation({
  data,
  selected,
}: Readonly<{
  data: WorkflowFlowEdge['data'];
  selected: EdgeProps<WorkflowFlowEdge>['selected'];
}>) {
  return {
    intoIssue: data?.intoIssue ?? false,
    proposed: data?.proposed ?? false,
    failure: data?.failure ?? false,
    timedOut: data?.timedOut ?? false,
    flowing: data?.flowing ?? false,
    isSelected: selected ?? false,
    weaveOrder: data?.weaveOrder ?? null,
  };
}

function edgeClassName(
  {
    intoIssue,
    failure,
    timedOut,
    isSelected,
    proposed,
  }: ReturnType<typeof edgePresentation>,
  hovered: boolean,
) {
  return cn(
    '!stroke-[1.6] transition-[stroke] duration-(--duration-quick) motion-reduce:transition-none',
    intoIssue
      ? '!stroke-destructive [stroke-dasharray:4_5]'
      : '!stroke-graph-link',
    failure && '!stroke-destructive [stroke-dasharray:1_4_7_4]',
    timedOut && '!stroke-warning/75 [stroke-dasharray:6_4]',
    hovered && '!stroke-accent-foreground/75',
    isSelected && '!stroke-primary !stroke-2',
    proposed && '!stroke-live [stroke-dasharray:5_5]',
    FOCUSED_THREAD,
  );
}

function EdgeStatusLabel({
  x,
  y,
  failure,
  proposed,
}: Readonly<{ x: number; y: number; failure: boolean; proposed: boolean }>) {
  const failureLabel = proposed ? 'On failure' : '× Failure';
  return (
    <EdgeLabelRenderer>
      <span
        className={cn(
          'pointer-events-none absolute flex items-center gap-1 rounded bg-card/90 px-1.5 text-caption whitespace-nowrap',
          failure ? 'text-destructive' : 'text-warning',
        )}
        style={{
          transform: `translate(-50%, -50%) translate(${String(x)}px, ${String(y - 14)}px)`,
        }}
      >
        {failure ? (
          failureLabel
        ) : (
          <>
            <TimedOutGlyph className="size-3" />
            Timed out
          </>
        )}
      </span>
    </EdgeLabelRenderer>
  );
}

function EdgeActions({
  id,
  x,
  y,
  data,
  onShow,
  onHide,
}: Readonly<{
  id: string;
  x: number;
  y: number;
  data: WorkflowFlowEdge['data'];
  onShow: () => void;
  onHide: () => void;
}>) {
  const { insertIntoLink, removeEdge } = use(CanvasActionsContext);
  const link = `link from ${data?.sourceLabel ?? 'a step'} to ${data?.targetLabel ?? 'a step'}`;
  return (
    <EdgeToolbar
      edgeId={id}
      x={x}
      y={y}
      isVisible
      className="nodrag nopan lens flex items-center rounded-lg"
      onMouseEnter={onShow}
      onMouseLeave={onHide}
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Insert step into ${link}`}
        onClick={(event) => {
          insertIntoLink(id, event.currentTarget);
        }}
      >
        <PlusIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${link}`}
        onClick={() => {
          removeEdge(id);
        }}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </EdgeToolbar>
  );
}
