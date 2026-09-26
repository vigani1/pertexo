import type { StatusTone } from '@/components/ui/status';
import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import {
  segmentPlacement,
  type ThreadSegment,
  type ThreadView,
} from '../../model/thread-view';
import { statusToneText } from '@/components/ui/status-tone';

function percent(value: number): string {
  return `${String(Math.round(value * 100) / 100)}%`;
}

function segmentClass(segment: ThreadSegment): string {
  switch (segment.kind) {
    case 'wait':
      return 'h-0 border-t-2 border-dashed border-current opacity-75';
    case 'skipped':
      return 'h-0 border-t-2 border-dashed border-current opacity-50';
    case 'pending':
      return 'h-0 border-t-2 border-dotted border-current opacity-45';
    case 'attempt':
      return segment.tone === 'live' && segment.endMs === null
        ? 'h-[3px] rounded-full bg-linear-to-r from-primary/30 via-primary to-accent-foreground shadow-[0_0_6px_color-mix(in_srgb,var(--primary)_45%,transparent)]'
        : 'h-[3px] rounded-full bg-current opacity-85';
  }
}

function SegmentEnd({ segment }: Readonly<{ segment: ThreadSegment }>) {
  const base = 'absolute top-1/2 right-0 -translate-y-1/2';
  if (
    segment.kind === 'attempt' &&
    segment.tone === 'live' &&
    segment.endMs === null
  )
    return (
      <span
        className={cn(
          base,
          'size-3 translate-x-1/2 rounded-full bg-[radial-gradient(circle,white_0_18%,var(--accent-foreground)_30%,color-mix(in_srgb,var(--primary)_35%,transparent)_55%,transparent_72%)] motion-safe:animate-tip',
        )}
      />
    );
  switch (segment.end) {
    case 'knot':
      return (
        <span
          className={cn(
            base,
            'size-2.5 translate-x-1/2 rounded-full bg-current shadow-[0_0_0_3px_color-mix(in_srgb,currentColor_15%,transparent)] motion-safe:animate-knot',
          )}
        />
      );
    case 'fray':
      return (
        <svg
          viewBox="0 0 22 16"
          className={cn(
            base,
            'h-4 w-5 translate-x-full motion-safe:animate-fray',
          )}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M0 8h7M10 4l8 8M18 4l-8 8" />
        </svg>
      );
    case 'bar':
      return (
        <span className={cn(base, 'h-3.5 w-0.5 rounded-full bg-current')} />
      );
    case 'cut':
      return (
        <span
          className={cn(
            base,
            'h-3 w-0.5 translate-x-1 rotate-[20deg] bg-current',
          )}
        />
      );
    case 'gap':
      return (
        <span
          className={cn(
            base,
            'w-4 translate-x-full border-t-2 border-dotted border-current motion-safe:animate-blink',
          )}
        />
      );
    default:
      return null;
  }
}

/**
 * One step's thread on the run's time axis: attempts as solid segments,
 * waits and scheduled retries as coiled dashes, pending as dots.
 */
export function ThreadTrack({
  view,
  segments,
  tag,
  tone,
  nowMs,
}: Readonly<{
  view: Pick<ThreadView, 'startMs' | 'endMs'>;
  segments: readonly ThreadSegment[];
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
              <StatusGlyph
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
          'absolute top-0.5 hidden max-w-60 truncate font-mono text-[0.68rem] leading-4 whitespace-nowrap sm:block',
          tone === 'failure' || tone === 'timeout'
            ? 'text-destructive/85'
            : 'text-subtle-foreground',
        )}
        style={tagStyle}
      >
        {tag}
      </span>
    </div>
  );
}
