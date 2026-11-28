import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { WorkflowTemplateOrigin } from '@/features/workflows/workflows-views.public';
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
                <>
                  Rename the workflow from its name in{' '}
                  <Link
                    to="/w/$workspaceId/workflows/$workflowId"
                    params={{ workspaceId: workspace.id, workflowId: shown.id }}
                    className="inline-link"
                  >
                    Build
                  </Link>
                  .
                  <WorkflowTemplateOrigin
                    apiClient={apiClient}
                    userId={userId}
                    workspace={workspace}
                    workflowId={shown.id}
                  />
                </>
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
