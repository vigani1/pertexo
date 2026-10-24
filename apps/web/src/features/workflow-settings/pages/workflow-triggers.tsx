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
import { SettingsSection } from '@/components/patterns/settings/section';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../components/settings-read-failure';
import { SchedulesSection } from '../components/triggers/schedules/section';
import { WebhooksSection } from '../components/triggers/webhooks/section';
import { triggerStepName } from '../model/triggers/steps';
import { publishedTriggerKinds } from '../model/triggers/published';
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
  editable,
}: Readonly<{
  kind: 'Webhook' | 'Schedule';
  workspaceId: string;
  workflowId: string;
  editable: boolean;
}>) {
  return (
    <p className="text-sm text-muted-foreground">
      The published version has no {kind} step.
      {editable ? (
        <>
          {' '}
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={{ workspaceId, workflowId }}
            className="inline-link"
          >
            Add one in Build
          </Link>
          , then publish.
        </>
      ) : null}
    </p>
  );
}

/** How the published version's runs start, and the controls for each. */
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
          ? 'Runs start only when someone runs the workflow. To start them on their own, add a Webhook, Schedule or Form step in Build, then publish.'
          : 'Triggers come from the published version. Add a trigger step in Build, then publish.'}
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
  { name: 'Form', detail: 'Someone submits its form.', on: false },
  {
    name: 'On failure',
    detail: 'Another workflow fails and hands its error here.',
    on: false,
  },
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
                : 'border border-surface-ink/20',
            )}
          />
          {/* Phones stack the sentence under its name, not beside it. */}
          <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
            <span className="font-medium sm:w-24 sm:shrink-0">{way.name}</span>
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
  const editable = workspace.capabilities.includes('workflow:update');
  // Webhook addresses and their deliveries are for the people who build
  // (owners, admins, builders); others aren't sent to ask for them.
  const webhooks = useQuery({
    ...webhookTriggersQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      workflowId,
    ),
    enabled: editable,
  });
  const schedules = useQuery(
    scheduleTriggersQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const versions = useQuery(
    workflowVersionsQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const summary = useQuery(
    workflowSummaryQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
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

  // Form and failure triggers have nothing to manage here, but they still
  // start runs, so the page must not claim the version has no trigger.
  const kinds = publishedTriggerKinds(
    versions.data?.items,
    summary.data?.publishedVersionId,
  );
  const form = kinds?.includes('core.form') ?? false;
  const onFailure = kinds?.includes('core.workflow_error') ?? false;

  // Only someone who can read webhooks knows the version has none.
  const needsFirstTrigger =
    editable &&
    webhookItems?.length === 0 &&
    scheduleItems?.length === 0 &&
    !form &&
    !onFailure;
  if (needsFirstTrigger)
    return (
      <NoTriggers
        workspaceId={workspace.id}
        workflowId={workflowId}
        published={summary.data?.publishedVersionId !== null}
      />
    );
  return (
    <div className="flex flex-col">
      {form ? (
        <SettingsSection
          title="Form"
          description="Starts a run each time someone submits the form. Its link, fields and who may submit are set on the Form step."
        >
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={{ workspaceId: workspace.id, workflowId }}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
          >
            Open Build
          </Link>
        </SettingsSection>
      ) : null}
      {onFailure ? (
        <SettingsSection
          title="On failure"
          description="Starts a run when another workflow fails and names this one as its error workflow."
        >
          <p className="text-sm text-muted-foreground">
            Each workflow chooses its error workflow in its own Settings.
          </p>
        </SettingsSection>
      ) : null}
      <SettingsSection
        title="Webhooks"
        description="Start a run when another system sends an event to the endpoint address."
      >
        {editable ? (
          <>
            <QueryView
              query={webhooks}
              resource="Webhooks"
              failure={settingsReadFailure}
              isEmpty={(listed) => listed.items.length === 0}
              empty={<NoTriggerStep kind="Webhook" {...common} />}
            />
            <WebhooksSection
              {...common}
              triggers={webhookItems ?? []}
              stepNameFor={(trigger) => stepName(trigger, 'Webhook')}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Webhook addresses and deliveries are shown to owners, admins and
            builders.
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Schedules"
        description="Start runs on a timetable. Times follow each schedule’s time zone."
      >
        <QueryView
          query={schedules}
          resource="Schedules"
          failure={settingsReadFailure}
          isEmpty={(listed) => listed.items.length === 0}
          empty={<NoTriggerStep kind="Schedule" {...common} />}
        />
        <SchedulesSection
          {...common}
          triggers={scheduleItems ?? []}
          stepNameFor={(trigger) => stepName(trigger, 'Schedule')}
        />
      </SettingsSection>
    </div>
  );
}
