import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import { PencilIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { ProviderTile } from '@/features/connections/provider.public';
import { formatRelativeTime } from '@/lib/format-time';
import type { DestinationMutationScope } from '../failure-notifications.mutations';
import { describeDestination } from '../model/destination-copy';
import { DestinationStatusSwitch } from './destination-status-switch';

export function DestinationRow({
  scope,
  destination,
  connections,
  canManage,
  onEdit,
}: Readonly<{
  scope: DestinationMutationScope;
  destination: FailureNotificationDestinationResponse;
  connections: readonly ConnectionResponse[];
  canManage: boolean;
  onEdit: (destinationId: string) => void;
}>) {
  const { label, connectionProblem } = describeDestination(
    destination,
    connections,
  );
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-2 border-t border-border py-3.5 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
      <ProviderTile provider={destination.kind} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {destination.kind === 'slack' ? 'Slack channel' : 'Email'} · updated{' '}
          {formatRelativeTime(destination.updatedAt)}
        </p>
        {connectionProblem === undefined ? null : (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
            <StatusGlyph tone="attention" />
            {connectionProblem}
          </p>
        )}
      </div>
      <DestinationStatusSwitch
        scope={scope}
        destinationId={destination.id}
        label={label}
        status={destination.status}
        disabled={!canManage}
      />
      {canManage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="col-start-3 justify-self-end sm:col-start-auto"
          aria-label={`Edit ${label}`}
          onClick={() => {
            onEdit(destination.id);
          }}
        >
          <PencilIcon data-icon="inline-start" aria-hidden="true" />
          Edit
        </Button>
      ) : null}
    </li>
  );
}
