import { PageHeaderTitle } from '@/components/patterns/page-header';
import { isAdministrativeRole } from '@pertexo/policy';
import { McpExposureSection } from '../components/settings/mcp-exposure-section';
import { NoticeSubjectActions } from '@/features/inbox/inbox-views.public';
import { SettingRow, SettingsGroup } from '@/components/patterns/settings/row';
import { ErrorWorkflowSection } from '../components/settings/error-workflow-section';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { workflowSummaryQueryOptions } from '@/features/workflows/workflows-queries.public';
import type { ApiClient } from '@/lib/api/client';
import { FailureAlertsSection } from '../components/settings/failure-alerts-section';
import { WorkflowPolicySummary } from '../components/settings/policy-summary';
import { IdentitySection } from '../components/settings/identity-section';
import { TriggerPauseRow } from '../components/trigger-pause-row';
import { LifecycleSection } from '../components/settings/lifecycle-section';
import { RunDurationSection } from '../components/settings/run-duration-section';
import { AutoPauseSection } from '../components/settings/auto-pause-section';
import { ConcurrencySection } from '../components/settings/concurrency-section';
import { shownData } from '@/lib/api/error-copy';

type SettingsPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

/**
 * Identity, notifications, what happens when it fails, how it runs, and
 * lifecycle for one workflow.
 */
export function WorkflowSettingsPage(props: SettingsPageProps) {
  return (
    <SettingsSession
      key={`${props.user.id}:${props.workspace.id}:${props.workflowId}`}
      {...props}
    />
  );
}

function SettingsSession({
  apiClient,
  user,
  workspace,
  workflowId,
}: SettingsPageProps) {
  const summary = useQuery(
    workflowSummaryQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const workflow = shownData(summary);
  return (
    <div className="flex max-w-190 flex-col gap-10">
      <header className="flex flex-col gap-2">
        <PageHeaderTitle size="section">Workflow settings</PageHeaderTitle>
        {workflow === undefined ? null : (
          <WorkflowPolicySummary
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
            workflow={workflow}
          />
        )}
      </header>
      <IdentitySection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        query={summary}
      />
      {workspace.status === 'active' ? (
        <SettingsGroup title="Your notifications">
          <SettingRow
            title="This workflow in your Inbox"
            description="Follow or mute it for your Inbox and email. Only you are affected."
            action={
              <NoticeSubjectActions
                scope={{
                  apiClient,
                  userId: user.id,
                  workspaceId: workspace.id,
                }}
                subject={{ subjectKind: 'workflow', subjectId: workflowId }}
                name={workflow?.name ?? 'this workflow'}
              />
            }
          />
        </SettingsGroup>
      ) : null}
      <SettingsGroup title="When it fails">
        <FailureAlertsSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
        />
        <ErrorWorkflowSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
        />
        <AutoPauseSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
        />
      </SettingsGroup>
      <SettingsGroup title="How it runs">
        <RunDurationSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflow={workflow}
        />
        <ConcurrencySection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
        />
      </SettingsGroup>
      {workspace.status === 'active' && isAdministrativeRole(workspace.role) ? (
        <SettingsGroup title="MCP exposure">
          <McpExposureSection
            scope={{
              apiClient,
              userId: user.id,
              workspaceId: workspace.id,
              workflowId,
            }}
          />
        </SettingsGroup>
      ) : null}
      {workflow === undefined ? null : (
        <TriggerPauseRow
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflow={workflow}
        />
      )}
      <LifecycleSection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflowId={workflowId}
        query={summary}
      />
    </div>
  );
}
