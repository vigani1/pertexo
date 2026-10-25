import type { UsageCapacityResponse } from '@pertexo/contracts';
import type { ReactNode } from 'react';
import { formatByteLength } from '@/lib/format/bytes';
import { SlotWheel, StorageArc } from './capacity-loom';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { cn } from '@/lib/utils';

const policyLabels: Readonly<
  Record<UsageCapacityResponse['execution']['policy']['state'], string>
> = {
  active: 'Active',
  suspended: 'Suspended',
  not_yet_effective: 'Not yet effective',
  expired: 'Expired',
  unavailable: 'Unavailable',
};

/** One exact figure with its limit and a thin meter under it. */
function CapacityFigure({
  label,
  used,
  limit,
  usedCount,
  limitCount,
}: Readonly<{
  label: string;
  used: ReactNode;
  limit: ReactNode;
  usedCount: number;
  limitCount: number | null;
}>) {
  const share =
    limitCount === null || limitCount <= 0
      ? 0
      : Math.min(1, usedCount / limitCount);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="min-w-0 font-mono text-sm break-all">
          <span className="text-foreground">{used}</span>
          <span className="text-subtle-foreground"> / {limit}</span>
        </dd>
      </div>
      <span
        aria-hidden="true"
        className="relative h-1 overflow-hidden rounded-full bg-surface-ink/[0.07]"
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            share >= 0.9 ? 'bg-warning' : 'bg-action/70',
          )}
          style={{
            width: `${String((usedCount > 0 ? Math.max(share, 0.02) : 0) * 100)}%`,
          }}
        />
      </span>
    </div>
  );
}

/** A capacity instrument: its drawing, a headline and its exact figures. */
function Instrument({
  title,
  headline,
  drawing,
  children,
}: Readonly<{
  title: string;
  headline: ReactNode;
  drawing: ReactNode;
  children: ReactNode;
}>) {
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-surface-ink/7 bg-surface-ink/[0.02] p-5">
      <div className="flex min-w-0 items-center gap-5">
        {drawing}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{headline}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Stored bytes as thousandths of the limit, for a meter. */
function byteShare(chargedBytes: string, byteLimit: string): number {
  const limit = BigInt(byteLimit);
  if (limit === 0n) return 0;
  return Number((BigInt(chargedBytes) * 1000n) / limit);
}

/** How much room is left, or that there is none. */
function storageHeadline(chargedBytes: string, byteLimit: string): string {
  const limit = BigInt(byteLimit);
  const used = BigInt(chargedBytes);
  if (limit === 0n) return 'No storage capacity';
  if (used >= limit) return 'Full: new files can’t be stored.';
  return `Room for ${formatByteLength(limit - used)} more.`;
}

export function CurrentCapacity({
  snapshot,
}: Readonly<{ snapshot: UsageCapacityResponse }>) {
  const { execution, artifacts } = snapshot;
  const reserved = execution.reservedActiveSlots;
  const limit = execution.policy.activeRunLimit;
  const free =
    limit === null
      ? null
      : Math.max(0, limit - execution.activeCapacityConsumed);
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-4">
      <Instrument
        title="Runs at once"
        drawing={<SlotWheel execution={execution} />}
        headline={executionHeadline(execution, free)}
      >
        <dl className="flex flex-col gap-3">
          <CapacityFigure
            label="In progress"
            used={execution.activeCapacityConsumed.toLocaleString(
              FORMAT_LOCALE,
            )}
            limit={limit?.toLocaleString(FORMAT_LOCALE) ?? 'limit unavailable'}
            usedCount={execution.activeCapacityConsumed}
            limitCount={limit}
          />
          <CapacityFigure
            label="Queued runs"
            used={execution.queuedRuns.toLocaleString(FORMAT_LOCALE)}
            limit={
              execution.policy.queuedRunLimit?.toLocaleString(FORMAT_LOCALE) ??
              'limit unavailable'
            }
            usedCount={execution.queuedRuns}
            limitCount={execution.policy.queuedRunLimit}
          />
        </dl>
        <p className="text-xs leading-relaxed text-subtle-foreground">
          A run stays in progress until it finishes, even while it waits.
          {reservedPlaces(reserved)}
        </p>
        {execution.policy.state === 'active' ? null : (
          <p className="text-sm">
            New runs aren’t accepted right now: this workspace’s limits are{' '}
            <strong>
              {policyLabels[execution.policy.state].toLowerCase()}
            </strong>
            . Runs already accepted keep their limits.
          </p>
        )}
      </Instrument>
      <Instrument
        title="Storage"
        drawing={
          <StorageArc
            chargedBytes={artifacts.chargedBytes}
            byteLimit={artifacts.byteLimit}
          />
        }
        headline={storageHeadline(artifacts.chargedBytes, artifacts.byteLimit)}
      >
        <dl className="flex flex-col gap-3">
          <CapacityFigure
            label="Stored"
            used={
              <span title={`${artifacts.chargedBytes} bytes`}>
                {formatByteLength(artifacts.chargedBytes)}
              </span>
            }
            limit={formatByteLength(artifacts.byteLimit)}
            usedCount={byteShare(artifacts.chargedBytes, artifacts.byteLimit)}
            limitCount={1000}
          />
          <CapacityFigure
            label="Files"
            used={artifacts.chargedCount.toLocaleString(FORMAT_LOCALE)}
            limit={artifacts.artifactCountLimit.toLocaleString(FORMAT_LOCALE)}
            usedCount={artifacts.chargedCount}
            limitCount={artifacts.artifactCountLimit}
          />
        </dl>
        <p className="text-xs leading-relaxed text-subtle-foreground">
          Files count from upload until they’re fully deleted.
        </p>
      </Instrument>
    </div>
  );
}

function executionHeadline(
  execution: UsageCapacityResponse['execution'],
  free: number | null,
): string {
  const idle = execution.activeRuns === 0 && execution.queuedRuns === 0;
  if (idle)
    return free === null
      ? 'Idle.'
      : `Idle, all ${free.toLocaleString(FORMAT_LOCALE)} places free.`;
  return `${execution.activeRuns.toLocaleString(FORMAT_LOCALE)} running${
    free === null ? '' : `, ${free.toLocaleString(FORMAT_LOCALE)} free`
  }${
    execution.queuedRuns === 0
      ? ''
      : `, ${execution.queuedRuns.toLocaleString(FORMAT_LOCALE)} waiting`
  }.`;
}

function reservedPlaces(reserved: number): string | null {
  if (reserved === 0) return null;
  if (reserved === 1)
    return ' One more place is held for a queued run about to start.';
  return ` ${String(reserved)} more places are held for queued runs about to start.`;
}
