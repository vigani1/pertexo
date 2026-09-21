import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import type { FailureNotificationDestinationList } from '@/features/failure-notifications/public';
import type { ApiClient } from '@/lib/api/client';
import { useFailureNotificationCommands } from '../mutations/use-notification-commands';
import {
  SettingsQueryState,
  SettingsSection,
  type SettingsQuery,
} from './settings-section';
import { visibleSettingsData } from './settings-query';

export function WorkflowNotificationsSection({
  apiClient,
  workspace,
  workflowId,
  query,
}: Readonly<{
  apiClient: ApiClient;
  workspace: AccessibleWorkspace;
  workflowId: string;
  query: SettingsQuery<FailureNotificationDestinationList>;
}>) {
  const [selectedId, setSelectedId] = useState('');
  const canSetPolicy = workspace.capabilities.includes('workflow:update');
  const canManageDestinations =
    workspace.capabilities.includes('connection:manage');
  const commands = useFailureNotificationCommands({
    apiClient,
    workspaceId: workspace.id,
    workflowId,
  });
  const data = visibleSettingsData(query);

  return (
    <SettingsSection
      id="workflow-notifications"
      title="Failure notifications"
      description="Choose where this workflow sends failure notifications. The current selection is unavailable, so Set and Clear report only changes confirmed in this session."
    >
      <SettingsQueryState query={query} />
      {data !== undefined && commands.error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {commands.error}
        </p>
      ) : null}
      {data !== undefined && commands.result ? (
        <p role="status" className="mb-3 text-sm text-primary">
          {commands.result}
        </p>
      ) : null}
      {data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No failure-notification destination is configured.
        </p>
      ) : null}
      <ul className="divide-y">
        {data?.items.map((destination) => (
          <li
            key={destination.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <p className="font-medium">
                {destination.config.kind === 'email'
                  ? destination.config.toEmail
                  : destination.config.channelId}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {destination.id}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  destination.status === 'enabled' ? 'muted' : 'secondary'
                }
              >
                {destination.status}
              </Badge>
            </div>
          </li>
        ))}
      </ul>
      {canManageDestinations ? (
        <Link
          to="/w/$workspaceId/settings/notifications"
          params={{ workspaceId: workspace.id }}
          className="mt-4 inline-flex text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Manage workspace destinations
        </Link>
      ) : null}
      {canSetPolicy && data && data.items.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <Field className="min-w-64 flex-1">
            <FieldLabel htmlFor="failure-destination">
              Destination for workflow failures
            </FieldLabel>
            <select
              id="failure-destination"
              name="failureDestination"
              className="recessed-control h-10 rounded-lg border px-3 text-base md:text-sm"
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
              }}
            >
              <option value="">Choose a destination</option>
              {data.items
                .filter((item) => item.status === 'enabled')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.kind} · {item.id}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            type="button"
            disabled={commands.pending || selectedId === ''}
            onClick={() => void commands.updatePolicy(selectedId)}
          >
            Set policy
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={commands.pending}
            onClick={() => void commands.updatePolicy()}
          >
            Clear policy
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}
