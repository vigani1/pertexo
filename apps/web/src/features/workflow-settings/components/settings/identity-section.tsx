import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import {
  WorkflowNameField,
  WorkflowTemplateOrigin,
} from '@/features/workflows/rename.public';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { CopyButton } from '@/components/ui/copy-button';
import { SettingsSection } from '@/components/patterns/settings/section';
import {
  QueryView,
  type ReadQuery,
} from '@/components/patterns/states/query-view';
import { visibleSettingsData } from '../../model/settings-query';
import { settingsReadFailure } from '../settings-read-failure';

function Moment({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">
        <time dateTime={value}>{formatRelativeTime(value)}</time>
        <span className="block font-mono text-[0.72rem] text-subtle-foreground">
          {formatDateTime(value)}
        </span>
      </dd>
    </div>
  );
}

function identityDescription(
  workspace: AccessibleWorkspace,
  workflow: WorkflowSummary | undefined,
): string {
  return workflow?.lifecycleStatus === 'archived' &&
    workspace.capabilities.includes('workflow:update')
    ? 'How this workflow is known. Restore it to rename it.'
    : 'How this workflow is known.';
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
  const workflow = visibleSettingsData(query);
  return (
    <SettingsSection
      title="Identity"
      description={identityDescription(workspace, workflow)}
    >
      <QueryView
        query={query}
        resource="This workflow"
        failure={settingsReadFailure}
      >
        {(shown) => (
          <>
            <dl className="grid gap-5 sm:grid-cols-2">
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Name</dt>
                <dd>
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
                </dd>
              </div>
              {/* The same short, copyable ID as the workspace's settings. */}
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Workflow ID</dt>
                <dd>
                  <CopyButton
                    value={shown.id}
                    display={`${shown.id.slice(0, 8)}…`}
                    label="Copy workflow ID"
                  />
                </dd>
              </div>
              <Moment label="Created" value={shown.createdAt} />
              <Moment label="Last updated" value={shown.updatedAt} />
            </dl>
            <WorkflowTemplateOrigin
              apiClient={apiClient}
              userId={userId}
              workspace={workspace}
              workflowId={shown.id}
              className="text-sm text-muted-foreground"
            />
          </>
        )}
      </QueryView>
    </SettingsSection>
  );
}
