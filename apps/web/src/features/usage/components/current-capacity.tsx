import type { UsageCapacityResponse } from '@pertexo/contracts';
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
  used: number;
  limit: number | null;
}>) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-border py-4">
      <dt className="text-sm">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-sm">
        <span className="text-foreground">{used}</span>
        <span className="text-subtle-foreground">
          {' '}
          / {limit ?? 'limit unavailable'}
        </span>
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
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-semibold">Execution</h3>
        <CapacityLoom execution={execution} />
        <dl>
          <CapacityRow
            label="Slots in use"
            used={execution.activeCapacityConsumed}
            limit={execution.policy.activeRunLimit}
          />
          <CapacityRow
            label="Queued runs"
            used={execution.queuedRuns}
            limit={execution.policy.queuedRunLimit}
          />
        </dl>
        <p className="text-sm text-muted-foreground">
          {execution.activeRuns} running or waiting
          {reserved === 0
            ? ''
            : `, ${String(reserved)} held for ${reserved === 1 ? 'a queued run' : 'queued runs'} about to start`}
          .
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
        <h3 className="mb-2 text-sm font-semibold">Artifact storage</h3>
        <StorageSpool
          chargedBytes={artifacts.chargedBytes}
          byteLimit={artifacts.byteLimit}
        />
        <dl>
          <CapacityRow
            label="Files"
            used={artifacts.chargedCount}
            limit={artifacts.artifactCountLimit}
          />
        </dl>
        <p className="text-sm text-muted-foreground">
          Files count from upload until they’re fully deleted.
        </p>
      </div>
    </div>
  );
}
