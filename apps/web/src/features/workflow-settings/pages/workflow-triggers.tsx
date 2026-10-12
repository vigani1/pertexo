import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
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
import { cn } from '@/lib/utils';
import { visibleSettingsData } from '../model/settings-query';
import { SettingsSection } from '@/components/patterns/settings-section';
import { SettingsQueryState } from '../components/settings-query-state';
import { SchedulesSection } from '../components/triggers/schedules/section';
import { WebhooksSection } from '../components/triggers/webhooks/section';
import { triggerStepName } from '../model/triggers/steps';
import {
  scheduleTriggersQueryOptions,
  webhookTriggersQueryOptions,
  workflowVersionsQueryOptions,
} from '../data/workflow-settings.queries';

type TriggersPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

/** A trigger kind the published version lacks, and where to add one. */
function NoTriggerStep({
  kind,
  workspaceId,
  workflowId,
}: Readonly<{
  kind: 'Webhook' | 'Schedule';
  workspaceId: string;
  workflowId: string;
}>) {
  return (
    <p className="text-sm text-muted-foreground">
      The published version has no {kind} step.{' '}
      <Link
        to="/w/$workspaceId/workflows/$workflowId"
        params={{ workspaceId, workflowId }}
        className="inline-link"
      >
        Add one in Build
      </Link>
      , then publish.
    </p>
  );
}

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
  // tab's empty state: no divider above it.
  return (
    <Empty className="border-t-0 py-2">
      <EmptyTitle>
        {published ? 'This version has no trigger' : 'Nothing is published yet'}
      </EmptyTitle>
      <EmptyDescription>
        {published
          ? 'Runs start only when someone runs the workflow. To start them on their own, add a Webhook or Schedule step in Build, then publish.'
          : 'Triggers come from the published version. Add a Webhook or Schedule step in Build, then publish.'}
      </EmptyDescription>
      {published ? <WaysIn /> : null}
      <EmptyActions>
        <Link
          to="/w/$workspaceId/workflows/$workflowId"
          params={{ workspaceId, workflowId }}
          className={buttonVariants({ variant: 'primary' })}
        >
          Open Build
        </Link>
      </EmptyActions>
    </Empty>
  );
}

const WAYS_IN = [
  { name: 'By hand', detail: 'Someone runs it from the workflow.', on: true },
  { name: 'Webhook', detail: 'Another system sends it an event.', on: false },
  { name: 'Schedule', detail: 'It runs on a timetable.', on: false },
] as const;

/** The ways a run can start, with the one this version has lit. */
function WaysIn() {
  return (
    <ul
      aria-label="Ways a run can start"
      className="my-1 flex w-full max-w-lg flex-col border-y border-border"
    >
      {WAYS_IN.map((way) => (
        <li
          key={way.name}
          className="flex items-center gap-3 border-t border-border py-2.5 text-sm first:border-t-0"
        >
          <span
            aria-hidden="true"
            className={cn(
              'size-2.5 shrink-0 rounded-full',
              way.on
                ? 'bg-action shadow-[0_0_8px_var(--action)]'
                : 'border border-white/20',
            )}
          />
          {/* Phones stack the sentence under its name, not beside it. */}
          <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
            <span className="font-medium sm:w-20 sm:shrink-0">{way.name}</span>
            <span className="text-muted-foreground max-sm:text-xs">
              {way.detail}
            </span>
          </span>
          <span
            className={cn(
              'shrink-0 text-xs',
              way.on ? 'text-action' : 'text-subtle-foreground',
            )}
          >
            {way.on ? 'On' : 'Not added'}
          </span>
        </li>
      ))}
    </ul>
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
          <NoTriggerStep
            kind="Webhook"
            workspaceId={workspace.id}
            workflowId={workflowId}
          />
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
          <NoTriggerStep
            kind="Schedule"
            workspaceId={workspace.id}
            workflowId={workflowId}
          />
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
