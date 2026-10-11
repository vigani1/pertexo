import type { UsageCapacityResponse } from '@pertexo/contracts';
import { StatusGlyph } from '@/components/ui/status';
import { formatByteLength } from '@/lib/format/bytes';

const VISIBLE_LANES = 12;

export function CapacityLoom({
  execution,
}: Readonly<{ execution: UsageCapacityResponse['execution'] }>) {
  const occupied = execution.activeCapacityConsumed;
  const count = Math.min(
    VISIBLE_LANES,
    Math.max(occupied, execution.policy.activeRunLimit ?? occupied, 0),
  );
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
              <span className="w-4 font-mono text-[0.6rem] text-subtle-foreground">
                {index + 1}
              </span>
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
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <StatusGlyph tone={execution.activeRuns > 0 ? 'live' : 'neutral'} />
          {execution.activeRuns} active, running or waiting
        </span>
        <span className="inline-flex items-center gap-1.5">
          <StatusGlyph
            tone={execution.reservedActiveSlots > 0 ? 'waiting' : 'neutral'}
          />
          {execution.reservedActiveSlots} reserved
        </span>
        {Math.max(occupied, execution.policy.activeRunLimit ?? 0) > count ? (
          <span>First {count} lanes shown</span>
        ) : null}
      </figcaption>
      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
        <svg
          aria-hidden="true"
          viewBox="0 0 120 22"
          className={
            execution.queuedRuns > 0
              ? 'h-6 w-28 shrink-0'
              : 'h-6 w-28 shrink-0 opacity-30'
          }
          fill="none"
          stroke="var(--muted-foreground)"
          strokeWidth="1.5"
        >
          <path d="M0 11H22c8-14 20-14 20 0s-12 14-12 0 12-14 20 0 12 14 12 0 12-14 20 0H120" />
        </svg>
        <span className="text-xs text-muted-foreground">
          {execution.queuedRuns} queued{' '}
          {execution.queuedRuns === 1 ? 'thread' : 'threads'}
        </span>
      </div>
    </figure>
  );
}

export function StorageSpool({
  chargedBytes,
  byteLimit,
}: Readonly<{ chargedBytes: string; byteLimit: string }>) {
  const limit = BigInt(byteLimit);
  const used = BigInt(chargedBytes);
  const filled =
    limit === 0n ? (used > 0n ? 100n : 0n) : (used * 100n + limit / 2n) / limit;
  const percent = Number(filled > 100n ? 100n : filled);
  const turns = Math.round(percent / 5);
  return (
    <figure
      className="my-5 flex items-center gap-5"
      aria-label={`${formatByteLength(chargedBytes)} stored of ${formatByteLength(byteLimit)}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 100 110"
        className="h-28 w-24 shrink-0"
        fill="none"
        strokeWidth="2"
      >
        <path
          d="M20 16H80M20 94H80M28 16V94M72 16V94"
          className="stroke-border"
          strokeLinecap="round"
        />
        <path d="M50 16V94" className="stroke-subtle-foreground/30" />
        {Array.from({ length: turns }, (_, index) => (
          <path
            key={index}
            d={`M29 ${String(89 - index * 3.5)}Q50 ${String(94 - index * 3.5)} 71 ${String(89 - index * 3.5)}`}
            className="stroke-accent-foreground"
          />
        ))}
        <path
          d="M72 87C88 87 85 106 100 106"
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
          of {formatByteLength(byteLimit)} storage
        </p>
        <p className="mt-2 text-xs text-subtle-foreground">
          {limit === 0n ? 'No storage capacity' : `${String(percent)}% full`}
        </p>
      </figcaption>
    </figure>
  );
}
