import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { WorkflowLifecycleSection } from './components/workflow-lifecycle-section';
import { WorkflowNotificationsSection } from './components/workflow-notifications-section';
import { WorkflowSchedulesSection } from './components/workflow-schedules-section';
import { WorkflowVersionsSection } from './components/workflow-versions-section';
import { WorkflowWebhooksSection } from './components/workflow-webhooks-section';
import { workflowSettingsQueryOptions } from './workflow-settings.queries';

export function WorkflowSettingsPage({
  apiClient,
  user,
  workspace,
  workflowId,
  onBack,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
  onBack: () => void;
}>) {
  return (
    <WorkflowSettingsSession
      key={`${user.id}:${workspace.id}:${workflowId}`}
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      workflowId={workflowId}
      onBack={onBack}
    />
  );
}

function WorkflowSettingsSession({
  apiClient,
  user,
  workspace,
  workflowId,
  onBack,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
  onBack: () => void;
}>) {
  const options = workflowSettingsQueryOptions(
    apiClient,
    user.id,
    workspace.id,
    workflowId,
  );
  const summary = useQuery(options.summary);
  const versions = useQuery(options.versions);
  const schedules = useQuery(options.schedules);
  const webhooks = useQuery(options.webhooks);
  const destinations = useQuery(options.destinations);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="glass-panel rounded-xl p-5 sm:p-6">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back to editor
        </Button>
        <h1 className="mt-3 font-heading text-2xl font-semibold">
          Workflow settings
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Published triggers, immutable versions, failure notifications and
          lifecycle operations for this workflow.
        </p>
        <nav
          aria-label="Workflow settings sections"
          className="mt-5 flex gap-2 overflow-x-auto pb-1 text-sm"
        >
          {[
            ['Versions', '#workflow-versions'],
            ['Schedules', '#workflow-schedules'],
            ['Webhooks', '#workflow-webhooks'],
            ['Notifications', '#workflow-notifications'],
            ['Lifecycle', '#workflow-lifecycle'],
          ].map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="whitespace-nowrap rounded-lg px-3 py-2 text-muted-foreground hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <WorkflowVersionsSection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflowId={workflowId}
        query={versions}
      />
      <WorkflowSchedulesSection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflowId={workflowId}
        query={schedules}
      />
      <WorkflowWebhooksSection
        apiClient={apiClient}
        userId={user.id}
        workspace={workspace}
        workflowId={workflowId}
        query={webhooks}
      />
      <WorkflowNotificationsSection
        apiClient={apiClient}
        workspace={workspace}
        workflowId={workflowId}
        query={destinations}
      />
      <div className="mt-2 border-t border-destructive/20 pt-6">
        <WorkflowLifecycleSection
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
          query={summary}
        />
      </div>
    </div>
  );
}
