import type { StatusTone } from '@/components/patterns/status/status-mark';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { cn } from '@/lib/class-names';
import { segmentPlacement } from '../../../model/timeline/geometry';
import type {
  RunTimelineSegment,
  RunTimelineModel,
} from '../../../model/timeline/runs';
import { statusToneText } from '@/components/patterns/status/status-tone';

function percent(value: number): string {
  return `${String(Math.round(value * 100) / 100)}%`;
}

function segmentClass(segment: RunTimelineSegment): string {
  switch (segment.kind) {
    case 'wait':
      return 'h-0 border-t border-dashed border-current opacity-75';
    case 'skipped':
      return 'h-0 border-t border-dashed border-current opacity-50';
    case 'pending':
      return 'h-0 border-t border-dotted border-current opacity-45';
    case 'attempt':
      return segment.tone === 'live' && segment.endMs === null
        ? 'h-[3px] rounded-full bg-linear-to-r from-primary/30 via-primary to-accent-foreground shadow-live'
        : 'h-[3px] rounded-full bg-current opacity-85';
  }
}

function SegmentEnd({ segment }: Readonly<{ segment: RunTimelineSegment }>) {
  if (
    segment.end === undefined &&
    !(segment.kind === 'attempt' && segment.endMs === null)
  )
    return null;
  return (
    <StatusMark
      display="mark"
      tone={segment.tone}
      className="absolute top-1/2 right-0 translate-x-2 -translate-y-1/2"
    />
  );
}

/**
 * One step's thread on the run's time axis: attempts as solid segments,
 * waits and scheduled retries as coiled dashes, pending as dots.
 */
export function RunTimelineTrack({
  view,
  segments,
  tag,
  tone,
  nowMs,
}: Readonly<{
  view: Pick<RunTimelineModel, 'startMs' | 'endMs'>;
  segments: readonly RunTimelineSegment[];
  tag: string;
  tone: StatusTone;
  nowMs: number;
}>) {
  const placed = segments.map((segment) => ({
    segment,
    placement: segmentPlacement(view, segment, nowMs),
  }));
  // The note belongs to the latest segment: over its end when that's past
  // the middle (right-aligned, so it never drifts from its end mark), else
  // from its start.
  const last = placed.at(-1)?.placement;
  const lastStart = last?.left ?? 0;
  const lastEnd = lastStart + (last?.width ?? 0);
  const tagStyle =
    lastEnd > 50
      ? { right: percent(100 - lastEnd) }
      : { left: percent(lastStart) };
  return (
    <div aria-hidden="true" className="relative h-full min-w-0">
      {placed.map(({ segment, placement }, index) => {
        return (
          <span
            key={`${segment.kind}-${String(segment.startMs)}-${String(index)}`}
            className={cn(
              'absolute top-1/2 -translate-y-1/2',
              statusToneText[segment.tone],
            )}
            style={
              // Not started: a short stub waiting at now, not a line whose
              // length is just how long the run has taken so far.
              segment.kind === 'pending' && segment.endMs === null
                ? {
                    left: `max(0%, calc(${percent(placement.left + placement.width)} - 1.5rem))`,
                    width: '1.5rem',
                  }
                : {
                    left: percent(placement.left),
                    width: `max(${percent(placement.width)}, 4px)`,
                  }
            }
          >
            <span className={cn('block w-full', segmentClass(segment))} />
            {/* While it waits, the coil sits at its live end: now. */}
            {segment.kind === 'wait' && segment.endMs === null ? (
              <StatusMark
                display="mark"
                tone="waiting"
                className="absolute top-1/2 right-0 size-3.5 translate-x-1/2 -translate-y-1/2 bg-background"
              />
            ) : null}
            <SegmentEnd segment={segment} />
          </span>
        );
      })}
      <span
        className={cn(
          'absolute top-0.5 hidden max-w-60 truncate font-mono text-caption leading-4 whitespace-nowrap sm:block',
          tone === 'failure' || tone === 'timeout'
            ? 'text-destructive'
            : 'text-subtle-foreground',
        )}
        style={tagStyle}
      >
        {tag}
      </span>
    </div>
  );
}
