import type { UsageCapacityResponse } from '@pertexo/contracts';
import { formatByteLength } from '@/lib/format/bytes';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { cn } from '@/lib/utils';

const VISIBLE_SLOTS = 24;
const SIZE = 112;
const CENTRE = SIZE / 2;

/**
 * Runs at once as a wheel: one bead per slot around the count in progress.
 * A running slot glows, one held for a queued run about to start is a
 * violet ring, a free one a hollow bead. An idle workspace reads as a calm
 * full wheel of free slots, never as an empty box.
 */
export function SlotWheel({
  execution,
}: Readonly<{ execution: UsageCapacityResponse['execution'] }>) {
  const occupied = execution.activeCapacityConsumed;
  const total = Math.max(occupied, execution.policy.activeRunLimit ?? occupied);
  const shown = Math.min(VISIBLE_SLOTS, Math.max(total, 1));
  const radius = shown > 12 ? 46 : 42;
  const bead = shown > 12 ? 4 : 6;
  return (
    <figure
      className="relative size-28 shrink-0"
      aria-label={`${String(occupied)} of ${String(total)} runs in progress at once, ${String(execution.queuedRuns)} ${execution.queuedRuns === 1 ? 'run' : 'runs'} queued`}
    >
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
        className="size-full overflow-visible"
      >
        <circle
          cx={CENTRE}
          cy={CENTRE}
          r={radius}
          className="fill-none stroke-surface-ink/[0.06]"
          strokeWidth={1}
        />
        {Array.from({ length: shown }, (_, index) => {
          const angle = (index / shown) * Math.PI * 2 - Math.PI / 2;
          const x = CENTRE + Math.cos(angle) * radius;
          const y = CENTRE + Math.sin(angle) * radius;
          const running = index < execution.activeRuns;
          const held = !running && index < occupied;
          return (
            <circle
              key={index}
              cx={x}
              cy={y}
              r={bead}
              className={cn(
                running &&
                  'fill-primary stroke-primary drop-shadow-[0_0_4px_var(--primary)] motion-loop:animate-tip',
                held && 'fill-background stroke-secondary',
                !running && !held && 'fill-background stroke-border-strong',
              )}
              strokeWidth={1.5}
            />
          );
        })}
      </svg>
      <figcaption
        aria-hidden="true"
        className="absolute inset-0 grid place-content-center text-center"
      >
        <span className="font-display text-3xl leading-none [--display-optical-size:36]">
          {occupied.toLocaleString(FORMAT_LOCALE)}
        </span>
        <span className="mt-1 font-mono text-[0.62rem] text-subtle-foreground">
          of {total.toLocaleString(FORMAT_LOCALE)}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Stored bytes as a three-quarter arc: wound as far as storage is used, the
 * stored size in its centre. Any stored byte shows as a sliver.
 */
export function StorageArc({
  chargedBytes,
  byteLimit,
}: Readonly<{ chargedBytes: string; byteLimit: string }>) {
  const limit = BigInt(byteLimit);
  const used = BigInt(chargedBytes);
  const filled = storageThousandths({ used, limit });
  const share = Math.min(1, Number(filled) / 1000);
  const shown = used > 0n ? Math.max(share, 0.015) : 0;
  const radius = 44;
  const sweep = 0.75;
  const length = 2 * Math.PI * radius;
  return (
    <figure
      className="relative size-28 shrink-0"
      aria-label={`${formatByteLength(chargedBytes)} stored of ${formatByteLength(byteLimit)}`}
    >
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
        className="size-full rotate-[135deg]"
      >
        <circle
          cx={CENTRE}
          cy={CENTRE}
          r={radius}
          className="fill-none stroke-surface-ink/[0.07]"
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={`${String(length * sweep)} ${String(length)}`}
        />
        {shown === 0 ? null : (
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={radius}
            className={cn(
              'fill-none',
              share >= 0.9 ? 'stroke-warning' : 'stroke-accent-foreground',
            )}
            strokeWidth={7}
            strokeLinecap="round"
            strokeDasharray={`${String(length * sweep * shown)} ${String(length)}`}
          />
        )}
      </svg>
      <figcaption
        aria-hidden="true"
        className="absolute inset-0 grid place-content-center text-center"
      >
        <span className="font-display text-xl leading-none [--display-optical-size:28]">
          {storageShareLabel({ used, limit, share })}
        </span>
        <span className="mt-1 font-mono text-[0.62rem] text-subtle-foreground">
          full
        </span>
      </figcaption>
    </figure>
  );
}

function storageThousandths({
  used,
  limit,
}: Readonly<{ used: bigint; limit: bigint }>): bigint {
  if (limit === 0n) return used > 0n ? 1000n : 0n;
  return (used * 1000n) / limit;
}

function storageShareLabel({
  used,
  limit,
  share,
}: Readonly<{ used: bigint; limit: bigint; share: number }>): string {
  if (limit === 0n) return '—';
  if (used > 0n && share < 0.01) return '<1%';
  return `${String(Math.round(share * 100))}%`;
}
