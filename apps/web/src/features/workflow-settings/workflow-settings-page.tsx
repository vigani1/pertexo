import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { FailureAlertsSection } from './components/settings/failure-alerts-section';
import { IdentitySection } from './components/settings/identity-section';
import { LifecycleSection } from './components/settings/lifecycle-section';
import { RunDurationSection } from './components/settings/run-duration-section';
import { visibleSettingsData } from './model/settings-query';

type SettingsPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

/** Identity, failure alerts, run duration and lifecycle for one workflow. */
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
  return (
    <div className="flex flex-col">
      <IdentitySection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        query={summary}
      />
      <FailureAlertsSection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflowId={workflowId}
      />
      <RunDurationSection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflow={visibleSettingsData(summary)}
      />
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
