import { useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNotifications } from '@/components/ui/use-notifications';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import {
  destinationChannels,
  useSlackChannelNames,
  type ChannelNames,
} from '@/features/failure-notifications/channel-names.public';
import {
  failureNotificationDestinationsQueryOptions,
  type FailureNotificationDestinationList,
} from '@/features/failure-notifications/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { describeDestination } from '../../model/destination-label';
import { useFailureNotificationCommands } from '../../mutations/use-notification-commands';
import { visibleSettingsData } from '../../model/settings-query';
import { failureNotificationPolicyQueryOptions } from '../../workflow-settings.queries';
import { SettingsSection } from '@/components/patterns/settings-section';
import { SettingsQueryState } from '../settings-section';
import { CurrentAlertDestination } from './current-alert-destination';
import { roleLimitSentence } from '@/features/workspaces/roles.public';

const NO_NAMES: ReadonlyMap<string, string> = new Map();

function connectionNames(
  list: Readonly<{ items: readonly Readonly<{ id: string; name: string }>[] }>,
): ReadonlyMap<string, string> {
  return new Map(
    list.items.map((connection) => [connection.id, connection.name]),
  );
}

/** Enabled destinations as choices, each named in words. */
function destinationOptions(
  list: FailureNotificationDestinationList | undefined,
  names: ReadonlyMap<string, string>,
  channelNames: ChannelNames,
) {
  return (list?.items ?? [])
    .filter((destination) => destination.status === 'enabled')
    .map((destination) => ({
      value: destination.id,
      label: describeDestination(destination, names, channelNames),
    }));
}

type DestinationOption = ReturnType<typeof destinationOptions>[number];

/**
 * What the section reads: the workflow's current destination, the enabled
 * destinations it could switch to, and the names that say each in words.
 */
function useAlertChoices({
  apiClient,
  userId,
  workspace,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>) {
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const enabled = can('workflow:update');
  const destinations = useQuery({
    ...failureNotificationDestinationsQueryOptions(
      apiClient,
      userId,
      workspace.id,
    ),
    enabled,
  });
  const connections = useQuery({
    ...connectionDiscoveryQueryOptions(apiClient, userId, workspace.id),
    enabled: enabled && can('connection:read'),
    select: connectionNames,
  });
  const policy = useQuery({
    ...failureNotificationPolicyQueryOptions(
      apiClient,
      userId,
      workspace.id,
      workflowId,
    ),
    enabled,
  });
  const current = visibleSettingsData(policy);
  const currentDestination = current?.destination ?? null;
  const listed = visibleSettingsData(destinations);
  const channelNames = useSlackChannelNames({
    apiClient,
    userId,
    workspaceId: workspace.id,
    channels: destinationChannels([
      ...(currentDestination === null ? [] : [currentDestination]),
      ...(listed?.items ?? []),
    ]),
    enabled: enabled && can('connection:use'),
  });
  const names = connections.data ?? NO_NAMES;
  return {
    policy,
    destinations,
    current,
    connectionNames: names,
    channelNames,
    options: destinationOptions(listed, names, channelNames),
  } as const;
}

/** Choose where failures go instead, or turn them off. */
function DestinationPicker({
  options,
  pending,
  alertsOff,
  onSave,
  onTurnOff,
}: Readonly<{
  options: readonly DestinationOption[];
  pending: boolean;
  alertsOff: boolean;
  onSave: (option: DestinationOption) => void;
  onTurnOff: () => void;
}>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = options.find((option) => option.value === selectedId);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field className="min-w-64 flex-1">
        <FieldLabel id="failure-destination-label">
          Send failure alerts to
        </FieldLabel>
        <Select
          items={options}
          value={selectedId}
          onValueChange={(value) => {
            setSelectedId(typeof value === 'string' ? value : null);
          }}
        >
          <SelectTrigger aria-labelledby="failure-destination-label">
            <SelectValue placeholder="Choose a destination" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <ProgressButton
        type="button"
        pending={pending}
        pendingLabel="Saving…"
        disabled={selected === undefined}
        onClick={() => {
          if (selected !== undefined) onSave(selected);
        }}
      >
        Save destination
      </ProgressButton>
      <Button
        type="button"
        variant="outline"
        disabled={pending || alertsOff}
        onClick={onTurnOff}
      >
        Turn alerts off
      </Button>
    </div>
  );
}

/**
 * Where this workflow's failures are announced: the current choice, then a
 * destination to send them to instead, or turning them off.
 */
export function FailureAlertsSection({
  apiClient,
  userId,
  workspace,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>) {
  const choices = useAlertChoices({ apiClient, userId, workspace, workflowId });
  const commands = useFailureNotificationCommands({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const notifications = useNotifications();
  const canSet = workspace.capabilities.includes('workflow:update');

  async function update(option?: DestinationOption) {
    if (!(await commands.updatePolicy(option?.value))) return;
    notifications.success(
      option === undefined
        ? { title: 'Failure alerts turned off' }
        : {
            title: 'Failure alerts updated',
            description: `Failures now go to: ${option.label}`,
          },
    );
  }

  return (
    <SettingsSection
      title="Failure alerts"
      description="Where Pertexo tells you when a run of this workflow fails."
    >
      {!canSet ? (
        <p className="text-sm text-muted-foreground">
          {roleLimitSentence(
            workspace.role,
            'workflow:update',
            'change failure alerts',
          )}
        </p>
      ) : (
        <>
          <SettingsQueryState
            query={choices.policy}
            resource="The current alert destination"
          />
          {choices.current === undefined ? null : (
            <CurrentAlertDestination
              destination={choices.current.destination}
              connectionNames={choices.connectionNames}
              channelNames={choices.channelNames}
            />
          )}
          <SettingsQueryState
            query={choices.destinations}
            resource="Alert destinations"
          />
          {choices.destinations.data !== undefined &&
          choices.options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There’s no enabled alert destination in this workspace yet.
            </p>
          ) : null}
          {commands.error === undefined ? null : (
            <Notice tone="destructive">{commands.error}</Notice>
          )}
          {choices.options.length === 0 ? null : (
            <DestinationPicker
              options={choices.options}
              pending={commands.pending}
              alertsOff={choices.current?.destination === null}
              onSave={(option) => void update(option)}
              onTurnOff={() => void update()}
            />
          )}
          {workspace.capabilities.includes('connection:manage') ? (
            <Link
              to="/w/$workspaceId/alerts"
              params={{ workspaceId: workspace.id }}
              className="w-fit text-sm font-medium text-accent-foreground underline decoration-accent-foreground/35 underline-offset-4 hover:decoration-accent-foreground"
            >
              Manage alert destinations
            </Link>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
