import type { UsageCapacityResponse } from '@pertexo/contracts';
import { formatByteLength } from '@/lib/format/bytes';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { cn } from '@/lib/class-names';

const policyLabels: Readonly<
  Record<UsageCapacityResponse['execution']['policy']['state'], string>
> = {
  active: 'Active',
  suspended: 'Suspended',
  not_yet_effective: 'Not yet effective',
  expired: 'Expired',
  unavailable: 'Unavailable',
};

/** A share at or above this fills the meter with the warning colour. */
const NEARLY_FULL = 0.9;

/**
 * The room left, in two sentences: file storage with one meter, then how
 * many runs are going at once and how many wait behind them.
 */
export function CurrentCapacity({
  snapshot,
}: Readonly<{ snapshot: UsageCapacityResponse }>) {
  const { execution, artifacts } = snapshot;
  const share = byteShare(artifacts.chargedBytes, artifacts.byteLimit);
  const limit = execution.policy.activeRunLimit;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base">
        Files use{' '}
        <span
          className="font-mono text-sm"
          title={`${artifacts.chargedBytes} bytes`}
        >
          {formatByteLength(artifacts.chargedBytes)}
        </span>{' '}
        of{' '}
        <span className="font-mono text-sm">
          {formatByteLength(artifacts.byteLimit)}
        </span>{' '}
        <span className="text-subtle-foreground">
          · {storageRoom(artifacts.chargedBytes, artifacts.byteLimit)}
        </span>
      </p>
      <span
        role="img"
        aria-label={`${String(Math.round(share * 100))}% of file storage used`}
        className="relative h-1 overflow-hidden rounded-full bg-select-raised"
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            share >= NEARLY_FULL ? 'bg-warning' : 'bg-muted-foreground',
          )}
          style={{
            width: `${String((share > 0 ? Math.max(share, 0.02) : 0) * 100)}%`,
          }}
        />
      </span>
      <p className="text-meta text-subtle-foreground">
        {artifacts.chargedCount.toLocaleString(FORMAT_LOCALE)} of{' '}
        {artifacts.artifactCountLimit.toLocaleString(FORMAT_LOCALE)} files,
        counted from upload until they’re fully deleted.
      </p>
      <p className="text-meta text-subtle-foreground">
        Right now{' '}
        <span className="font-mono text-muted-foreground">
          {execution.activeCapacityConsumed.toLocaleString(FORMAT_LOCALE)}
        </span>
        {limit === null ? (
          ' runs are going at once'
        ) : (
          <>
            {' '}
            of{' '}
            <span className="font-mono text-muted-foreground">
              {limit.toLocaleString(FORMAT_LOCALE)}
            </span>{' '}
            runs at once are going
          </>
        )}
        , with{' '}
        <span className="font-mono text-muted-foreground">
          {execution.queuedRuns.toLocaleString(FORMAT_LOCALE)}
        </span>{' '}
        queued behind them.{reservedPlaces(execution.reservedActiveSlots)}
      </p>
      {execution.policy.state === 'active' ? null : (
        <p className="text-sm">
          New runs aren’t accepted right now: this workspace’s limits are{' '}
          <strong>{policyLabels[execution.policy.state].toLowerCase()}</strong>.
          Runs already accepted keep their limits.
        </p>
      )}
    </div>
  );
}

/** Stored bytes as a share of the limit, from 0 to 1. */
function byteShare(chargedBytes: string, byteLimit: string): number {
  const limit = BigInt(byteLimit);
  if (limit === 0n) return 0;
  return Math.min(1, Number((BigInt(chargedBytes) * 1000n) / limit) / 1000);
}

/** How much room is left, or that there is none. */
function storageRoom(chargedBytes: string, byteLimit: string): string {
  const limit = BigInt(byteLimit);
  const used = BigInt(chargedBytes);
  if (limit === 0n) return 'no storage capacity';
  if (used >= limit) return 'full: new files can’t be stored';
  return `room for ${formatByteLength(limit - used)} more`;
}

function reservedPlaces(reserved: number): string | null {
  if (reserved === 0) return null;
  if (reserved === 1)
    return ' One more place is held for a queued run about to start.';
  return ` ${String(reserved)} more places are held for queued runs about to start.`;
}
