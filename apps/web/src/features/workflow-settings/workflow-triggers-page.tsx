import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/ui/empty';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { visibleSettingsData } from './model/settings-query';
import {
  SettingsQueryState,
  SettingsSection,
} from './components/settings-section';
import { SchedulesSection } from './components/triggers/schedules-section';
import { WebhooksSection } from './components/triggers/webhooks-section';
import { triggerStepName } from './model/trigger-steps';
import {
  scheduleTriggersQueryOptions,
  webhookTriggersQueryOptions,
  workflowVersionsQueryOptions,
} from './workflow-settings.queries';

type TriggersPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

/** Webhooks and schedules from the published version, and their controls. */
export function WorkflowTriggersPage(props: TriggersPageProps) {
  // A new identity is a new session: late credentials never cross workflows.
  return (
    <TriggersSession
      key={`${props.user.id}:${props.workspace.id}:${props.workflowId}`}
      {...props}
    />
  );
}

function NoTriggers({
  workspaceId,
  workflowId,
  published,
}: Readonly<{ workspaceId: string; workflowId: string; published: boolean }>) {
  // The tab's first content sits right under the hub bar, like the Versions
  // tab's empty state: no divider above it and no decorative glyph.
  return (
    <Empty className="border-t-0 py-2">
      <EmptyTitle>
        {published ? 'This version has no trigger' : 'Nothing is published yet'}
      </EmptyTitle>
      <EmptyDescription>
        {published
          ? 'Add a Webhook or Schedule step in Build, then publish. Until then, runs start only when someone runs the workflow.'
          : 'Triggers come from the published version. Add a Webhook or Schedule step in Build, then publish.'}
      </EmptyDescription>
      <EmptyActions>
        <Link
          to="/w/$workspaceId/workflows/$workflowId"
          params={{ workspaceId, workflowId }}
          className={buttonVariants({ variant: 'default' })}
        >
          Open Build
        </Link>
      </EmptyActions>
    </Empty>
  );
}

function TriggersSession({
  apiClient,
  user,
  workspace,
  workflowId,
}: TriggersPageProps) {
  const webhooks = useQuery(
    webhookTriggersQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const schedules = useQuery(
    scheduleTriggersQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const versions = useQuery(
    workflowVersionsQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const summary = useQuery(
    workflowSummaryQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const editable = workspace.capabilities.includes('workflow:update');
  const webhookItems = visibleSettingsData(webhooks)?.items;
  const scheduleItems = visibleSettingsData(schedules)?.items;
  const stepName = (
    trigger: Readonly<{ workflowVersionId: string; nodeId: string }>,
    fallback: string,
  ) => triggerStepName(versions.data?.items, trigger, fallback);
  const common = {
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    workflowId,
    editable,
  };

  if (webhookItems?.length === 0 && scheduleItems?.length === 0)
    return (
      <NoTriggers
        workspaceId={workspace.id}
        workflowId={workflowId}
        published={summary.data?.publishedVersionId !== null}
      />
    );
  return (
    <div className="flex flex-col">
      <SettingsSection
        title="Webhooks"
        description="Start a run when another system sends an event to the endpoint address."
      >
        <SettingsQueryState query={webhooks} resource="Webhooks" />
        {webhookItems?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The published version has no Webhook step.
          </p>
        ) : null}
        <WebhooksSection
          {...common}
          triggers={webhookItems ?? []}
          stepNameFor={(trigger) => stepName(trigger, 'Webhook')}
        />
      </SettingsSection>
      <SettingsSection
        title="Schedules"
        description="Start runs on a timetable. Times follow each schedule’s time zone."
      >
        <SettingsQueryState query={schedules} resource="Schedules" />
        {scheduleItems?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The published version has no Schedule step.
          </p>
        ) : null}
        <SchedulesSection
          {...common}
          triggers={scheduleItems ?? []}
          stepNameFor={(trigger) => stepName(trigger, 'Schedule')}
        />
      </SettingsSection>
    </div>
  );
}
