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
  failureNotificationDestinationsQueryOptions,
  type FailureNotificationDestinationList,
} from '@/features/failure-notifications/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { describeDestination } from '../../model/destination-label';
import { useFailureNotificationCommands } from '../../mutations/use-notification-commands';
import { visibleSettingsData } from '../../model/settings-query';
import { failureNotificationPolicyQueryOptions } from '../../workflow-settings.queries';
import { SettingsQueryState, SettingsSection } from '../settings-section';
import { CurrentAlertDestination } from './current-alert-destination';

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
) {
  return (list?.items ?? [])
    .filter((destination) => destination.status === 'enabled')
    .map((destination) => ({
      value: destination.id,
      label: describeDestination(destination, names),
    }));
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
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const canSet = can('workflow:update');
  const notifications = useNotifications();
  const destinations = useQuery({
    ...failureNotificationDestinationsQueryOptions(
      apiClient,
      userId,
      workspace.id,
    ),
    enabled: canSet,
  });
  const connections = useQuery({
    ...connectionDiscoveryQueryOptions(apiClient, userId, workspace.id),
    enabled: canSet && can('connection:read'),
    select: connectionNames,
  });
  const policy = useQuery({
    ...failureNotificationPolicyQueryOptions(
      apiClient,
      userId,
      workspace.id,
      workflowId,
    ),
    enabled: canSet,
  });
  const current = visibleSettingsData(policy);
  const commands = useFailureNotificationCommands({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const options = destinationOptions(
    visibleSettingsData(destinations),
    connections.data ?? NO_NAMES,
  );
  const selected = options.find((option) => option.value === selectedId);

  async function update(destinationId?: string) {
    if (!(await commands.updatePolicy(destinationId))) return;
    notifications.success(
      destinationId === undefined
        ? { title: 'Failure alerts turned off' }
        : {
            title: 'Failure alerts updated',
            description: `Failures now go to: ${selected?.label ?? 'the chosen destination'}`,
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
          Your role can’t change failure alerts. Builders, admins and owners
          can.
        </p>
      ) : (
        <>
          <SettingsQueryState
            query={policy}
            resource="The current alert destination"
          />
          {current === undefined ? null : (
            <CurrentAlertDestination
              destination={current.destination}
              connectionNames={connections.data ?? NO_NAMES}
            />
          )}
          <SettingsQueryState
            query={destinations}
            resource="Alert destinations"
          />
          {destinations.data !== undefined && options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There’s no enabled alert destination in this workspace yet.
            </p>
          ) : null}
          {commands.error === undefined ? null : (
            <Notice tone="destructive">{commands.error}</Notice>
          )}
          {options.length === 0 ? null : (
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
                pending={commands.pending}
                pendingLabel="Saving…"
                disabled={selected === undefined}
                onClick={() => {
                  if (selected !== undefined) void update(selected.value);
                }}
              >
                Save destination
              </ProgressButton>
              <Button
                type="button"
                variant="outline"
                disabled={commands.pending || current?.destination === null}
                onClick={() => void update()}
              >
                Turn alerts off
              </Button>
            </div>
          )}
          {can('connection:manage') ? (
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
