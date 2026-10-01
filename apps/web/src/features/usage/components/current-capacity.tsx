import type { UsageCapacityResponse } from '@pertexo/contracts/schemas/workflow-runs';

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
  unit,
}: Readonly<{
  label: string;
  used: string | number;
  limit: string | number | null;
  unit?: string;
}>) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-border py-4">
      <dt className="text-sm">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-sm">
        <span className="text-foreground">{used}</span>
        {unit === undefined ? null : ` ${unit}`}
        <span className="text-subtle-foreground">
          {' '}
          /{' '}
          {limit === null
            ? 'limit unavailable'
            : `${String(limit)}${unit === undefined ? '' : ` ${unit}`}`}
        </span>
      </dd>
    </div>
  );
}

export function CurrentCapacity({
  snapshot,
}: Readonly<{ snapshot: UsageCapacityResponse }>) {
  const { execution, artifacts } = snapshot;
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-semibold">Execution</h3>
        <dl>
          <CapacityRow
            label="Active capacity consumed"
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
          {execution.activeRuns} active{' '}
          {execution.activeRuns === 1 ? 'run' : 'runs'} (running or waiting) +{' '}
          {execution.reservedActiveSlots} reserved active{' '}
          {execution.reservedActiveSlots === 1 ? 'slot' : 'slots'}. Reserved
          runs are still queued; these figures must not be added as distinct
          runs.
        </p>
        <p className="mt-3 text-sm">
          Current acceptance policy:{' '}
          <strong>{policyLabels[execution.policy.state]}</strong>
          {execution.policy.version === null
            ? ''
            : ` (version ${String(execution.policy.version)})`}
          .
        </p>
        <p className="mt-2 text-xs text-subtle-foreground">
          Configured limits are not remaining admission slots. Already accepted
          runs retain their pinned policy.{' '}
          {execution.policy.state === 'active'
            ? 'Capacity can change before a new run is submitted.'
            : 'This policy is not active for new acceptance; unavailable or expired limits do not mean unlimited capacity.'}
        </p>
      </div>
      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-semibold">Artifact storage</h3>
        <dl>
          <CapacityRow
            label="Charged artifact bytes"
            used={artifacts.chargedBytes}
            limit={artifacts.byteLimit}
            unit="bytes"
          />
          <CapacityRow
            label="Charged artifact count"
            used={artifacts.chargedCount}
            limit={artifacts.artifactCountLimit}
          />
        </dl>
        <p className="text-sm text-muted-foreground">
          Pending, available and deleting artifacts remain charged until
          physical deletion completes.
        </p>
        <p className="mt-3 text-xs text-subtle-foreground">
          {artifacts.source === 'default'
            ? 'Default capacity applies before the first artifact reservation.'
            : 'Stored capacity. A zero limit means zero capacity, not unlimited storage.'}{' '}
          Exact byte values are shown without rounding.
        </p>
      </div>
    </div>
  );
}
