import { useAlertMembers } from '../hooks/use-alert-members';
import { DestinationTest } from './destination-test';
import type {
  ConnectionResponse,
  FailureNotificationDestinationResponse,
} from '@pertexo/contracts';
import { PencilIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { SettingRow } from '@/components/patterns/settings/row';
import { formatRelativeTime } from '@/lib/format/time';
import type { DestinationMutationScope } from '../data/failure-notifications.mutations';
import type { ChannelNames } from '../model/channel-names';
import { describeDestination } from '../model/destination-copy';
import { DestinationStatusSwitch } from './destination-status-switch';

export function DestinationRow({
  scope,
  destination,
  connections,
  channelNames,
  canManage,
  onEdit,
}: Readonly<{
  scope: DestinationMutationScope;
  destination: FailureNotificationDestinationResponse;
  connections: readonly ConnectionResponse[];
  channelNames: ChannelNames;
  canManage: boolean;
  onEdit: (destinationId: string) => void;
}>) {
  const { members } = useAlertMembers(
    scope,
    destination.kind === 'system_mail',
  );
  const { label, connectionProblem, channelNote } = describeDestination(
    destination,
    connections,
    channelNames,
    members,
  );
  return (
    <SettingRow
      title={label}
      description={
        <>
          {destination.kind === 'slack' ? 'Slack channel' : 'Email'} · updated{' '}
          {formatRelativeTime(destination.updatedAt)}
          {connectionProblem === undefined ? null : (
            <span className="mt-1 flex items-center gap-1.5 text-warning">
              <StatusMark display="mark" tone="attention" />
              {connectionProblem}
            </span>
          )}
          {channelNote === undefined ? null : (
            <span className="mt-1 block">{channelNote}</span>
          )}
        </>
      }
      action={
        <>
          {canManage ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${label}`}
              onClick={() => {
                onEdit(destination.id);
              }}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
          ) : null}
          <DestinationStatusSwitch
            scope={scope}
            destinationId={destination.id}
            label={label}
            status={destination.status}
            disabled={!canManage}
          />
        </>
      }
    >
      {canManage && destination.kind !== 'system_mail' ? (
        <DestinationTest
          key={`${destination.id}:${String(destination.currentVersion)}`}
          scope={scope}
          destination={destination}
          label={label}
          disabled={connectionProblem !== undefined}
        />
      ) : null}
    </SettingRow>
  );
}
