import type { UsageCapacityResponse } from '@pertexo/contracts';
import { StatusGlyph } from '@/components/ui/status';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/utils';

const VISIBLE_SLOTS = 12;
const VISIBLE_QUEUE = 9;

/**
 * Queued runs wait as beads on a thread that feeds the rack of run slots:
 * a free slot is an empty ring, a running one glows, one held for a queued
 * run about to start coils. Only real work moves.
 */
export function CapacityLoom({
  execution,
}: Readonly<{ execution: UsageCapacityResponse['execution'] }>) {
  const occupied = execution.activeCapacityConsumed;
  const total = Math.max(occupied, execution.policy.activeRunLimit ?? occupied);
  const shown = Math.min(VISIBLE_SLOTS, Math.max(total, 0));
  const queued = Math.max(execution.queuedRuns, 0);
  const beads = Math.min(VISIBLE_QUEUE, queued);
  return (
    <figure
      // As tall as the storage spool beside it, so the rows below line up.
      className="my-5 flex h-28 flex-col justify-center"
      aria-label={`${String(occupied)} of ${String(total)} run slots in use, ${String(queued)} ${queued === 1 ? 'run' : 'runs'} queued`}
    >
      <div aria-hidden="true" className="flex items-center">
        {/* The queue: beads wait in line, the first nearest the rack. */}
        <div className="relative flex h-8 min-w-12 flex-1 items-center justify-end gap-1.5 pr-2">
          <span
            className={cn(
              'absolute inset-x-0 top-1/2 h-px',
              queued > 0 ? 'bg-secondary/35' : 'bg-border',
            )}
          />
          {queued > beads ? (
            <span className="relative bg-background px-1 font-mono text-[0.62rem] text-secondary">
              +{queued - beads}
            </span>
          ) : null}
          {Array.from({ length: beads }, (_, index) => (
            <span
              key={index}
              style={{ animationDelay: `${String((beads - index) * 140)}ms` }}
              className="relative size-1.5 rounded-full bg-secondary motion-safe:animate-bead"
            />
          ))}
        </div>
        {/* The rack of slots. */}
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-white/[0.02] px-2.5 py-2">
          {Array.from({ length: shown }, (_, index) => {
            const running = index < execution.activeRuns;
            const held = !running && index < occupied;
            return (
              <span
                key={index}
                className={cn(
                  'grid size-7 place-items-center rounded-full border',
                  running &&
                    'border-primary/70 bg-primary/10 shadow-[0_0_8px_color-mix(in_srgb,var(--primary)_35%,transparent)]',
                  held && 'border-secondary/60',
                  !running && !held && 'border-border-strong',
                )}
              >
                {running ? (
                  <span className="size-2 rounded-full bg-primary motion-safe:animate-tip" />
                ) : held ? (
                  <StatusGlyph tone="waiting" className="size-3.5" />
                ) : null}
              </span>
            );
          })}
          {total > shown ? (
            <span className="pr-1 font-mono text-[0.62rem] text-subtle-foreground">
              +{total - shown}
            </span>
          ) : null}
        </div>
      </div>
      <figcaption
        aria-hidden="true"
        className="mt-2 flex justify-between gap-3 font-mono text-[0.6rem] text-subtle-foreground"
      >
        <span>Queue</span>
        <span>Slots</span>
      </figcaption>
    </figure>
  );
}

/** Stored bytes as thread wound on a spool: the winding widens as it fills. */
export function StorageSpool({
  chargedBytes,
  byteLimit,
}: Readonly<{ chargedBytes: string; byteLimit: string }>) {
  const limit = BigInt(byteLimit);
  const used = BigInt(chargedBytes);
  const filled =
    limit === 0n ? (used > 0n ? 100n : 0n) : (used * 100n + limit / 2n) / limit;
  const percent = Number(filled > 100n ? 100n : filled);
  // The winding grows from the core (half-width 5) to the flange edge (34).
  const half = 5 + (29 * percent) / 100;
  const wraps = percent === 0 ? [] : Array.from({ length: 19 }, (_, i) => i);
  return (
    <figure
      className="my-5 flex items-center gap-5"
      aria-label={`${formatByteLength(chargedBytes)} stored of ${formatByteLength(byteLimit)}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 110 110"
        className="h-28 w-28 shrink-0"
        fill="none"
        strokeLinecap="round"
      >
        {wraps.map((index) => (
          <path
            key={index}
            d={`M${String(50 - half)} ${String(19 + index * 4)}H${String(50 + half)}`}
            strokeWidth="1.2"
            className="stroke-accent-foreground"
          />
        ))}
        <path
          d="M45 14V96M55 14V96"
          strokeWidth="1.5"
          className="stroke-border"
        />
        <path
          d="M14 14H86M14 96H86"
          strokeWidth="3"
          className="stroke-border"
        />
        <path
          d={`M${String(50 + half)} 91C${String(64 + half)} 91 80 104 106 104`}
          strokeWidth="1.5"
          className="stroke-muted-foreground"
        />
      </svg>
      <figcaption className="min-w-0">
        <p
          title={`${chargedBytes} bytes`}
          className="font-mono text-2xl text-foreground"
        >
          {formatByteLength(chargedBytes)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          of {formatByteLength(byteLimit)}
        </p>
        <p className="mt-2 text-xs text-subtle-foreground">
          {limit === 0n ? 'No storage capacity' : `${String(percent)}% full`}
        </p>
      </figcaption>
    </figure>
  );
}
