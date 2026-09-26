import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { WorkflowNameField } from '@/features/workflows/rename.public';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { CopyButton } from '@/components/ui/copy-button';
import {
  visibleSettingsData,
  type SettingsQuery,
} from '../../model/settings-query';
import { SettingsQueryState, SettingsSection } from '../settings-section';

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
  query: SettingsQuery<WorkflowSummary>;
}>) {
  const workflow = visibleSettingsData(query);
  return (
    <SettingsSection
      title="Identity"
      description={identityDescription(workspace, workflow)}
    >
      <SettingsQueryState query={query} resource="This workflow" />
      {workflow === undefined ? null : (
        <dl className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Name</dt>
            <dd>
              <WorkflowNameField
                apiClient={apiClient}
                userId={userId}
                workspace={workspace}
                workflow={workflow}
                // The row already says Name; the field keeps it for readers.
                className="[&_[data-slot=field-label]]:sr-only"
              >
                <span className="min-w-0 text-base font-semibold break-words">
                  {workflow.name}
                </span>
              </WorkflowNameField>
            </dd>
          </div>
          {/* The same short, copyable ID as the workspace's settings. */}
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Workflow ID</dt>
            <dd>
              <CopyButton
                value={workflow.id}
                display={`${workflow.id.slice(0, 8)}…`}
                label="Copy workflow ID"
              />
            </dd>
          </div>
          <Moment label="Created" value={workflow.createdAt} />
          <Moment label="Last updated" value={workflow.updatedAt} />
        </dl>
      )}
    </SettingsSection>
  );
}
