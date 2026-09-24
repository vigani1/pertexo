import { useMemo } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { cn } from '@/lib/utils';
import { glyphEdgePath, layoutPatternGlyph } from '../model/workflow-shape';

const SIZES = {
  row: { width: 62, height: 28 },
  card: { width: 132, height: 48 },
  lens: { width: 220, height: 72 },
} as const;

type GlyphSize = keyof typeof SIZES;

const FLOW_CLASS = {
  on: 'motion-safe:opacity-100',
  hover:
    'motion-safe:group-hover/starter:opacity-100 motion-safe:group-focus-visible/starter:opacity-100 motion-safe:group-has-focus-visible/starter:opacity-100',
} as const;

/**
 * A workflow's silhouette: dots for steps, curved threads for connections,
 * the trigger lit in cyan. `muted` draws an unpublished draft; `flow` sends
 * light along each thread, always or while its starter card is hovered.
 * Always decorative.
 */
export function PatternGlyph({
  graph,
  size = 'row',
  muted = false,
  flow,
  className,
}: Readonly<{
  graph: WorkflowGraphContract;
  size?: GlyphSize;
  muted?: boolean;
  flow?: keyof typeof FLOW_CLASS | undefined;
  className?: string;
}>) {
  const layout = useMemo(
    () => layoutPatternGlyph(graph, SIZES[size]),
    [graph, size],
  );
  return (
    <svg
      aria-hidden="true"
      data-slot="pattern-glyph"
      viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
      width={layout.width}
      height={layout.height}
      className={cn('block shrink-0 overflow-visible', className)}
    >
      {layout.nodes
        .filter((node) => node.loop)
        .map((node) => (
          <circle
            key={`loop-${node.id}`}
            cx={node.x}
            cy={node.y}
            r={layout.radius + 2.6}
            className="fill-none stroke-secondary/40 [stroke-dasharray:1.6_1.6]"
            strokeWidth={0.9}
          />
        ))}
      {layout.edges.map((edge, index) => {
        const path = glyphEdgePath(edge.from, edge.to);
        return (
          <g key={edge.id}>
            <path
              d={path}
              strokeWidth={1.2}
              className={cn(
                'fill-none',
                muted
                  ? 'stroke-subtle-foreground/45 [stroke-dasharray:2_2]'
                  : 'stroke-accent-foreground/35',
              )}
            />
            {flow === undefined ? null : (
              <path
                d={path}
                strokeWidth={1.4}
                strokeLinecap="round"
                style={{ animationDelay: `${String(index * 320)}ms` }}
                className={cn(
                  'fill-none stroke-accent-foreground opacity-0 transition-opacity [stroke-dasharray:4_22] motion-safe:animate-thread-flow',
                  FLOW_CLASS[flow],
                )}
              />
            )}
          </g>
        );
      })}
      {layout.nodes.map((node) => (
        <circle
          key={node.id}
          cx={node.x}
          cy={node.y}
          r={node.trigger ? layout.radius + 0.6 : layout.radius}
          className={cn(
            muted
              ? 'fill-subtle-foreground'
              : node.trigger
                ? 'fill-primary drop-shadow-[0_0_3px_var(--primary)]'
                : 'fill-accent-foreground',
          )}
        />
      ))}
    </svg>
  );
}

/**
 * The honest stand-in while a shape loads or when it can't be read: a faint
 * thread without invented steps.
 */
export function PatternGlyphPlaceholder({
  state,
  size = 'row',
}: Readonly<{ state: 'loading' | 'unavailable'; size?: GlyphSize }>) {
  const { width, height } = SIZES[size];
  const middle = height / 2;
  return (
    <svg
      aria-hidden="true"
      data-slot="pattern-glyph"
      data-state={state}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width={width}
      height={height}
      className={cn(
        'block shrink-0',
        state === 'loading' && 'motion-safe:animate-blink',
      )}
    >
      <path
        d={`M5 ${String(middle)}H${String(width - 5)}`}
        strokeWidth={1.2}
        className="fill-none stroke-white/12 [stroke-dasharray:2_3]"
      />
      <circle
        cx={5}
        cy={middle}
        r={2.4}
        strokeWidth={1}
        className="fill-none stroke-subtle-foreground/70"
      />
    </svg>
  );
}
