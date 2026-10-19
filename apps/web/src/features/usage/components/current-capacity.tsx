import type { UsageCapacityResponse } from '@pertexo/contracts';
import type { ReactNode } from 'react';
import { formatByteLength } from '@/lib/format/bytes';
import { CapacityLoom, StorageSpool } from './capacity-loom';

const policyLabels: Readonly<
  Record<UsageCapacityResponse['execution']['policy']['state'], string>
> = {
  active: 'Active',
  suspended: 'Suspended',
  not_yet_effective: 'Not yet effective',
  expired: 'Expired',
  unavailable: 'Unavailable',
};

function CapacityRow({
  label,
  used,
  limit,
}: Readonly<{
  label: string;
  used: ReactNode;
  limit: ReactNode;
}>) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-border py-4">
      <dt className="text-sm">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-sm">
        <span className="text-foreground">{used}</span>
        <span className="text-subtle-foreground"> / {limit}</span>
      </dd>
    </div>
  );
}

export function CurrentCapacity({
  snapshot,
}: Readonly<{ snapshot: UsageCapacityResponse }>) {
  const { execution, artifacts } = snapshot;
  const reserved = execution.reservedActiveSlots;
  return (
    // Two halves with the same anatomy: a label, a drawing in the same
    // rack, two exact rows and one note.
    <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">Runs at once</h3>
        <CapacityLoom execution={execution} />
        <dl>
          <CapacityRow
            label="In progress"
            used={execution.activeCapacityConsumed.toLocaleString()}
            limit={
              execution.policy.activeRunLimit?.toLocaleString() ??
              'limit unavailable'
            }
          />
          <CapacityRow
            label="Queued runs"
            used={execution.queuedRuns.toLocaleString()}
            limit={
              execution.policy.queuedRunLimit?.toLocaleString() ??
              'limit unavailable'
            }
          />
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          A run stays in progress until it finishes, even while it waits.
          {reserved === 0
            ? null
            : reserved === 1
              ? ' One more place is held for a queued run about to start.'
              : ` ${String(reserved)} more places are held for queued runs about to start.`}
        </p>
        {execution.policy.state === 'active' ? null : (
          <p className="mt-3 text-sm">
            New runs aren’t accepted right now: this workspace’s limits are{' '}
            <strong>
              {policyLabels[execution.policy.state].toLowerCase()}
            </strong>
            . Runs already accepted keep their limits.
          </p>
        )}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">Storage</h3>
        <StorageSpool
          chargedBytes={artifacts.chargedBytes}
          byteLimit={artifacts.byteLimit}
        />
        <dl>
          <CapacityRow
            label="Stored"
            used={
              <span title={`${artifacts.chargedBytes} bytes`}>
                {formatByteLength(artifacts.chargedBytes)}
              </span>
            }
            limit={formatByteLength(artifacts.byteLimit)}
          />
          <CapacityRow
            label="Files"
            used={artifacts.chargedCount.toLocaleString()}
            limit={artifacts.artifactCountLimit.toLocaleString()}
          />
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Files count from upload until they’re fully deleted.
        </p>
      </div>
    </div>
  );
}
