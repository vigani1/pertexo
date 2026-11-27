import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import {
  WorkflowNameField,
  WorkflowTemplateOrigin,
} from '@/features/workflows/workflows-views.public';
import type { ApiClient } from '@/lib/api/client';
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
} from '@/lib/format/time';
import { CopyButton } from '@/components/ui/copy-button';
import { SettingRow, SettingsGroup } from '@/components/patterns/settings/row';
import {
  QueryView,
  type ReadQuery,
} from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../settings-read-failure';
import { shownData } from '@/lib/api/error-copy';

function identityDescription(
  workspace: AccessibleWorkspace,
  workflow: WorkflowSummary | undefined,
): string {
  return workflow?.lifecycleStatus === 'archived' &&
    workspace.capabilities.includes('workflow:update')
    ? 'Restore the workflow to rename it.'
    : 'What people see in lists, runs and the Inbox.';
}

/**
 * The workflow's name (renamed in place by its editors), its ID for support
 * and APIs, and its age.
 */
export function IdentitySection({
  apiClient,
  userId,
  workspace,
  query,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  query: ReadQuery<WorkflowSummary>;
}>) {
  const workflow = shownData(query);
  return (
    <SettingsGroup title="Identity">
      <QueryView
        query={query}
        resource="This workflow"
        failure={settingsReadFailure}
      >
        {(shown) => (
          <>
            <SettingRow
              title="Name"
              description={identityDescription(workspace, workflow)}
            >
              <WorkflowNameField
                apiClient={apiClient}
                userId={userId}
                workspace={workspace}
                workflow={shown}
                textClassName="text-base font-semibold"
              >
                <span className="min-w-0 text-base font-semibold break-words">
                  {shown.name}
                </span>
              </WorkflowNameField>
            </SettingRow>
            <SettingRow
              title="Workflow ID"
              description="How API clients and exports refer to this workflow."
              action={
                <CopyButton
                  value={shown.id}
                  display={`${shown.id.slice(0, 8)}…`}
                  label="Copy workflow ID"
                />
              }
            />
            <SettingRow
              title="Created"
              description={
                <WorkflowTemplateOrigin
                  apiClient={apiClient}
                  userId={userId}
                  workspace={workspace}
                  workflowId={shown.id}
                />
              }
              action={
                <span className="font-mono text-caption text-subtle-foreground">
                  <time
                    dateTime={shown.createdAt}
                    title={formatDateTime(shown.createdAt)}
                  >
                    {formatDate(shown.createdAt)}
                  </time>{' '}
                  · updated{' '}
                  <time
                    dateTime={shown.updatedAt}
                    title={formatDateTime(shown.updatedAt)}
                  >
                    {formatRelativeTime(shown.updatedAt)}
                  </time>
                </span>
              }
            />
          </>
        )}
      </QueryView>
    </SettingsGroup>
  );
}
