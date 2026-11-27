import type { ComponentProps } from 'react';
import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import { Notice } from '@/components/patterns/notices/inline-notice';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { PollingRows } from '../components/triggers/polling-rows';
import {
  StepTriggerRows,
  TriggerFootnotes,
} from '../components/triggers/step-rows';
import { RowList } from '@/components/patterns/lists/row';
import { NoTriggers } from '../components/triggers/no-triggers';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type { ApiClient } from '@/lib/api/client';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../components/settings-read-failure';
import { SchedulesSection } from '../components/triggers/schedules/section';
import { WebhooksSection } from '../components/triggers/webhooks/section';
import { UpcomingRuns } from '../components/triggers/schedules/upcoming';
import { triggerStepName } from '../model/triggers/steps';
import {
  publishedPollingTitle,
  publishedTriggerKinds,
} from '../model/triggers/published';
import {
  triggerPublicationQueryOptions,
  scheduleTriggersQueryOptions,
  webhookTriggersQueryOptions,
  workflowVersionsQueryOptions,
} from '../data/workflow-settings.queries';
import { workflowAutoPauseQueryOptions } from '../data/auto-pause.queries';
import { shownData } from '@/lib/api/error-copy';
import { hasNoPublishedTriggers } from '../model/triggers/published';
import { whoCan } from '@/features/workspaces/public';

/** Editing a workflow is what shows its webhooks and lets triggers change. */
const WEBHOOK_CAPABILITY = 'workflow:update';

type TriggersPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>;

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

function TriggersSession({
  apiClient,
  user,
  workspace,
  workflowId,
}: TriggersPageProps) {
  const editable = workspace.capabilities.includes(WEBHOOK_CAPABILITY);
  const props = { apiClient, user, workspace, workflowId };
  const webhooks = useWebhookTriggers(props, editable);
  const schedules = useScheduleTriggers(props);
  const publication = useTriggerPublication({
    apiClient,
    user,
    workspace,
    workflowId,
  });
  const {
    versions,
    summary,
    form,
    formsPaused,
    onFailure,
    pollingTitle,
    publicationKnown,
  } = publication;
  const webhookItems = shownData(webhooks)?.items;
  const scheduleItems = shownData(schedules)?.items;
  const stepName: TriggerStepName = (trigger, fallback) =>
    triggerStepName(versions.data?.items, trigger, fallback);
  const common = {
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    workflowId,
    editable,
  };

  // Only someone who can read webhooks knows the version has none.
  const needsFirstTrigger = hasNoPublishedTriggers({
    editable,
    webhookCount: webhookItems?.length,
    scheduleCount: scheduleItems?.length,
    form,
    onFailure,
    polling: pollingTitle !== undefined,
  });
  if (publicationKnown && needsFirstTrigger)
    return (
      <NoTriggers
        workspaceId={workspace.id}
        workflowId={workflowId}
        published={summary.data?.publishedVersionId !== null}
      />
    );
  return (
    <div className="flex max-w-190 flex-col gap-10">
      <TriggersHeader
        versions={versions.data?.items}
        publishedVersionId={summary.data?.publishedVersionId}
      />
      <PublicationDiscovery discovery={publication} />
      <TriggersSection
        common={common}
        reads={{ webhooks, schedules }}
        stepName={stepName}
        pollingTitle={pollingTitle}
        pollingTriggers={shownData(summary)?.pollingTriggers ?? []}
        steps={{
          versions: versions.data?.items,
          publishedVersionId: summary.data?.publishedVersionId,
          form,
          formsPaused,
          onFailure,
        }}
      />
      {(scheduleItems?.length ?? 0) === 0 ? null : (
        <UpcomingRuns
          apiClient={apiClient}
          userId={user.id}
          workspaceId={workspace.id}
          workflowId={workflowId}
          triggers={scheduleItems ?? []}
          stepNameFor={(trigger) => stepName(trigger, 'Schedule')}
        />
      )}
    </div>
  );
}

/** What the tab is, and which published version its triggers come from. */
function TriggersHeader({
  versions,
  publishedVersionId,
}: Readonly<{
  versions:
    readonly Readonly<{ id: string; versionNumber: number }>[] | undefined;
  publishedVersionId: string | null | undefined;
}>) {
  const published = versions?.find(
    (version) => version.id === publishedVersionId,
  );
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-heading text-section font-semibold">
        Ways a run can start
      </h1>
      <p className="text-meta text-subtle-foreground">
        {published === undefined
          ? 'From the published version.'
          : `From the published version, v${String(published.versionNumber)}.`}{' '}
        Turning a schedule off stops new runs from it right away; the draft is
        not touched.
      </p>
    </header>
  );
}

type TriggerStepName = (
  trigger: Readonly<{ workflowVersionId: string; nodeId: string }>,
  fallback: string,
) => string;

/** Every way the published version starts runs, one row each. */
function TriggersSection({
  common,
  reads,
  stepName,
  pollingTitle,
  pollingTriggers,
  steps,
}: Readonly<{
  common: Omit<
    ComponentProps<typeof SchedulesSection>,
    'triggers' | 'stepNameFor'
  >;
  reads: Readonly<{
    webhooks: ReturnType<typeof useWebhookTriggers>;
    schedules: ReturnType<typeof useScheduleTriggers>;
  }>;
  stepName: TriggerStepName;
  pollingTitle: string | undefined;
  pollingTriggers: ComponentProps<typeof PollingRows>['triggers'];
  steps: ComponentProps<typeof StepTriggerRows>;
}>) {
  return (
    <section aria-labelledby="workflow-triggers" className="flex flex-col">
      <RuleHeading id="workflow-triggers">Triggers</RuleHeading>
      {common.editable ? (
        <QueryView
          query={reads.webhooks}
          resource="Webhooks"
          failure={settingsReadFailure}
        />
      ) : null}
      <QueryView
        query={reads.schedules}
        resource="Schedules"
        failure={settingsReadFailure}
      />
      <RowList aria-label="Triggers" className="mt-2">
        {common.editable ? (
          <WebhooksSection
            {...common}
            triggers={shownData(reads.webhooks)?.items ?? []}
            stepNameFor={(trigger) => stepName(trigger, 'Webhook')}
          />
        ) : null}
        <SchedulesSection
          {...common}
          triggers={shownData(reads.schedules)?.items ?? []}
          stepNameFor={(trigger) => stepName(trigger, 'Schedule')}
        />
        {pollingTitle === undefined ? null : (
          <PollingRows
            title={pollingTitle}
            triggers={pollingTriggers}
            stepNameFor={(trigger) => stepName(trigger, pollingTitle)}
          />
        )}
        <StepTriggerRows {...steps} />
      </RowList>
      <TriggerFootnotes
        workspaceId={common.workspaceId}
        workflowId={common.workflowId}
        editable={common.editable}
        readers={whoCan(WEBHOOK_CAPABILITY)}
      />
    </section>
  );
}

function useWebhookTriggers(
  { apiClient, user, workspace, workflowId }: TriggersPageProps,
  editable: boolean,
) {
  // Webhook addresses and their deliveries are for the people who build;
  // others aren't sent to ask for them.
  return useQuery({
    ...webhookTriggersQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      workflowId,
    ),
    enabled: editable,
  });
}

function useScheduleTriggers({
  apiClient,
  user,
  workspace,
  workflowId,
}: TriggersPageProps) {
  return useQuery(
    scheduleTriggersQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
}

function useTriggerPublication({
  apiClient,
  user,
  workspace,
  workflowId,
}: TriggersPageProps) {
  const versions = useQuery(
    workflowVersionsQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  const summary = useQuery(
    triggerPublicationQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      workflowId,
    ),
  );
  // Form and failure triggers have nothing to manage here, but they still
  // start runs, so the page must not claim the version has no trigger.
  const kinds = publishedTriggerKinds(
    shownData(versions)?.items,
    shownData(summary)?.publishedVersionId,
  );
  const form = kinds?.includes('core.form') ?? false;
  const pause = useQuery({
    ...workflowAutoPauseQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      workflowId,
    ),
    enabled: form,
  });
  const formsPaused = shownData(pause)?.pauseState === 'paused';
  const onFailure = kinds?.includes('core.workflow_error') ?? false;

  const publicationKnown =
    summary.isSuccess &&
    !summary.isFetching &&
    (summary.data.publishedVersionId === null ||
      (versions.isSuccess && !versions.isFetching && kinds !== undefined));
  const pollingTitle = publishedPollingTitle(
    kinds,
    shownData(summary)?.pollingTriggers?.length,
  );
  return {
    versions,
    summary,
    kinds,
    form,
    formsPaused,
    onFailure,
    pollingTitle,
    publicationKnown,
  };
}

function PublicationDiscovery({
  discovery,
}: Readonly<{ discovery: ReturnType<typeof useTriggerPublication> }>) {
  const { versions, summary, kinds } = discovery;
  return (
    <>
      <QueryView
        query={summary}
        resource="The current publication"
        failure={settingsReadFailure}
      />
      {summary.data?.publishedVersionId === null ? null : (
        <QueryView
          query={versions}
          resource="The published version"
          failure={settingsReadFailure}
        />
      )}
      {summary.isSuccess &&
      summary.data.publishedVersionId !== null &&
      versions.isSuccess &&
      kinds === undefined ? (
        <Notice tone="warning">
          <ReadRecovery
            error={undefined}
            resource="The published version"
            message="The current published version is missing from the loaded versions. Reload it to discover its triggers."
            retrying={summary.isFetching || versions.isFetching}
            retry={() => {
              void Promise.all([summary.refetch(), versions.refetch()]);
            }}
          />
        </Notice>
      ) : null}
    </>
  );
}
