import type { UsageCapacityResponse } from '@pertexo/contracts';
import { StatusGlyph } from '@/components/ui/status';
import { formatByteLength } from '@/lib/format/bytes';
import { cn } from '@/lib/utils';

const VISIBLE_SLOTS = 12;

/**
 * Both capacity drawings sit in the same rack: one height, one outline,
 * with a small scale under it, so the two halves read as a pair.
 */
const RACK =
  'flex h-11 items-center rounded-full border border-border bg-white/[0.02] px-2.5';
const SCALE =
  'mt-2 flex justify-between gap-3 font-mono text-[0.6rem] text-subtle-foreground';
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
      className="my-5"
      aria-label={`${String(occupied)} of ${String(total)} runs in progress at once, ${String(queued)} ${queued === 1 ? 'run' : 'runs'} queued`}
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
              className="relative size-1.5 rounded-full bg-secondary motion-loop:animate-bead"
            />
          ))}
        </div>
        {/* The rack of slots. */}
        <div className={cn(RACK, 'shrink-0 gap-2')}>
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
                  <span className="size-2 rounded-full bg-primary motion-loop:animate-tip" />
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
      <figcaption aria-hidden="true" className={SCALE}>
        <span>Queued</span>
        <span>In progress</span>
      </figcaption>
    </figure>
  );
}

/**
 * Stored bytes as thread wound across the same rack: each wrap a fine line,
 * filled as far as the storage is used.
 */
export function StorageSpool({
  chargedBytes,
  byteLimit,
}: Readonly<{ chargedBytes: string; byteLimit: string }>) {
  const limit = BigInt(byteLimit);
  const used = BigInt(chargedBytes);
  const filled =
    limit === 0n ? (used > 0n ? 100n : 0n) : (used * 100n + limit / 2n) / limit;
  const percent = Number(filled > 100n ? 100n : filled);
  // Any stored byte shows as at least one wrap.
  const wound = used > 0n ? Math.max(percent, 1) : 0;
  return (
    <figure
      className="my-5"
      aria-label={`${formatByteLength(chargedBytes)} stored of ${formatByteLength(byteLimit)}`}
    >
      <div aria-hidden="true" className={RACK}>
        <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-full">
          {/* The winding stops in a straight edge where the storage ends;
              only the rack's own rounded ends shape it. */}
          <span
            className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(90deg,var(--accent-foreground)_0_1.5px,transparent_1.5px_4px)] opacity-75 after:absolute after:inset-y-0 after:right-0 after:w-0.5 after:bg-accent-foreground after:content-['']"
            style={{ width: `${String(wound)}%` }}
          />
        </div>
      </div>
      <figcaption aria-hidden="true" className={SCALE}>
        <span>
          {limit === 0n ? 'No storage capacity' : `${String(percent)}% full`}
        </span>
        <span>{formatByteLength(byteLimit)}</span>
      </figcaption>
    </figure>
  );
}
