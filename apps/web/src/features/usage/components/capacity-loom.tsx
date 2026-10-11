import type { UsageCapacityResponse } from '@pertexo/contracts';
import { StatusGlyph } from '@/components/ui/status';
import { formatByteLength } from '@/lib/format/bytes';

const VISIBLE_LANES = 12;

/** One lane per active-run slot: running work moves, reserved slots coil. */
export function CapacityLoom({
  execution,
}: Readonly<{ execution: UsageCapacityResponse['execution'] }>) {
  const occupied = execution.activeCapacityConsumed;
  const lanes = Math.max(occupied, execution.policy.activeRunLimit ?? occupied);
  const count = Math.min(VISIBLE_LANES, Math.max(lanes, 0));
  return (
    <figure
      className="my-5"
      aria-label={`${String(occupied)} active slots consumed, ${String(execution.queuedRuns)} runs queued`}
    >
      <div
        aria-hidden="true"
        className="flex flex-col gap-2 border-x border-border px-3 py-2"
      >
        {Array.from({ length: count }, (_, index) => {
          const active = index < execution.activeRuns;
          const reserved = !active && index < occupied;
          return (
            <div key={index} className="flex h-3 items-center gap-2">
              <svg
                viewBox="0 0 240 12"
                preserveAspectRatio="none"
                className="h-3 min-w-0 flex-1"
                fill="none"
                strokeWidth="1.5"
              >
                <path
                  d="M0 6H240"
                  className={active ? 'stroke-primary/30' : 'stroke-border'}
                />
                {active ? (
                  <path
                    d="M0 6H240"
                    pathLength="100"
                    strokeDasharray="8 24"
                    className="stroke-accent-foreground motion-safe:animate-[thread-drift_1.8s_linear_infinite]"
                  />
                ) : null}
                {reserved ? (
                  <path
                    d="M0 6H80c12-8 16 8 28 0s16 8 28 0H240"
                    className="stroke-warning"
                  />
                ) : null}
              </svg>
              <StatusGlyph
                tone={active ? 'live' : reserved ? 'waiting' : 'neutral'}
              />
            </div>
          );
        })}
      </div>
      {lanes > count ? (
        <figcaption className="mt-2 text-xs text-subtle-foreground">
          First {count} of {lanes} slots shown
        </figcaption>
      ) : null}
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
