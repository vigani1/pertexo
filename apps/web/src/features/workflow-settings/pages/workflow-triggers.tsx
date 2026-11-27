import { StatusMark } from '@/components/patterns/status/status-mark';
import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import { Notice } from '@/components/patterns/notices/inline-notice';
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
} from '@/components/patterns/states/empty';
import { PollingRows } from '../components/triggers/polling-rows';
import { TriggerRow } from '../components/triggers/trigger-row';
import { StepTile } from '@/features/catalog/catalog-views.public';
import { describeStep } from '@/features/catalog/public';
import { Row, RowList } from '@/components/patterns/lists/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type { ApiClient } from '@/lib/api/client';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from '../components/settings-read-failure';
import { SchedulesSection } from '../components/triggers/schedules/section';
import { WebhooksSection } from '../components/triggers/webhooks/section';
import { UpcomingRuns } from '../components/triggers/schedules/upcoming';
import { publishedStepNames, triggerStepName } from '../model/triggers/steps';
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

function NoTriggers({
  workspaceId,
  workflowId,
  published,
}: Readonly<{ workspaceId: string; workflowId: string; published: boolean }>) {
  // The tab's first content sits right under the hub bar, like the Versions
  // tab's empty state: no divider above it.
  return (
    <>
      <Empty className="border-t-0 py-2">
        <EmptyTitle>
          {published
            ? 'This version has no trigger'
            : 'Nothing is published yet'}
        </EmptyTitle>
        <EmptyDescription>
          {published
            ? 'Runs start only when someone runs the workflow. To start them on their own, add a Webhook, Schedule or Form step in Build, then publish.'
            : 'Triggers come from the published version. Add a trigger step in Build, then publish.'}
        </EmptyDescription>
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
      {published ? <WaysIn /> : null}
    </>
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
    <RowList aria-label="Ways a run can start" className="my-1 max-w-lg">
      {WAYS_IN.map((way) => (
        <Row
          key={way.name}
          lift="none"
          className="grid-cols-[minmax(0,1fr)_auto] py-2.5 text-sm sm:grid-cols-[6rem_minmax(0,1fr)_auto]"
        >
          <span className="font-medium">{way.name}</span>
          <span className="text-muted-foreground max-sm:col-start-1 max-sm:row-start-2 max-sm:text-xs">
            {way.detail}
          </span>
          <StatusMark tone={way.on ? 'success' : 'off'}>
            {way.on ? 'On' : 'Not added'}
          </StatusMark>
        </Row>
      ))}
    </RowList>
  );
}

function TriggersSession({
  apiClient,
  user,
  workspace,
  workflowId,
}: TriggersPageProps) {
  const editable = workspace.capabilities.includes(WEBHOOK_CAPABILITY);
  // Webhook addresses and their deliveries are for the people who build;
  // others aren't sent to ask for them.
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
  const publication = useTriggerPublication({
    apiClient,
    user,
    workspace,
    workflowId,
  });
  const { versions, summary, form, onFailure, pollingTitle, publicationKnown } =
    publication;
  const webhookItems = shownData(webhooks)?.items;
  const scheduleItems = shownData(schedules)?.items;
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
  const publishedNumber = versions.data?.items.find(
    (version) => version.id === summary.data?.publishedVersionId,
  )?.versionNumber;
  return (
    <div className="flex max-w-190 flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-section font-semibold">
          Ways a run can start
        </h1>
        <p className="text-meta text-subtle-foreground">
          {publishedNumber === undefined
            ? 'From the published version.'
            : `From the published version, v${String(publishedNumber)}.`}{' '}
          Turning a schedule off stops new runs from it right away; the draft is
          not touched.
        </p>
      </header>
      <PublicationDiscovery discovery={publication} />
      <section aria-labelledby="workflow-triggers" className="flex flex-col">
        <RuleHeading id="workflow-triggers">Triggers</RuleHeading>
        {editable ? (
          <QueryView
            query={webhooks}
            resource="Webhooks"
            failure={settingsReadFailure}
          />
        ) : null}
        <QueryView
          query={schedules}
          resource="Schedules"
          failure={settingsReadFailure}
        />
        <RowList aria-label="Triggers" className="mt-2">
          {editable ? (
            <WebhooksSection
              {...common}
              triggers={webhookItems ?? []}
              stepNameFor={(trigger) => stepName(trigger, 'Webhook')}
            />
          ) : null}
          <SchedulesSection
            {...common}
            triggers={scheduleItems ?? []}
            stepNameFor={(trigger) => stepName(trigger, 'Schedule')}
          />
          {pollingTitle === undefined ? null : (
            <PollingRows
              title={pollingTitle}
              triggers={shownData(summary)?.pollingTriggers ?? []}
              stepNameFor={(trigger) => stepName(trigger, pollingTitle)}
            />
          )}
          {form
            ? publishedStepNames(
                versions.data?.items,
                summary.data?.publishedVersionId,
                'core.form',
              ).map((step) => (
                <TriggerRow
                  key={step.nodeId}
                  label={`Form: ${step.name}`}
                  icon={<StepTile step={describeStep('core.form')} />}
                  name={step.name}
                  kind="Form · starts a run each time someone submits it. Its link, fields and who may submit are set on the step in Build."
                  state={<StatusMark tone="success">On</StatusMark>}
                />
              ))
            : null}
          {onFailure
            ? publishedStepNames(
                versions.data?.items,
                summary.data?.publishedVersionId,
                'core.workflow_error',
              ).map((step) => (
                <TriggerRow
                  key={step.nodeId}
                  label={`On failure: ${step.name}`}
                  icon={<StepTile step={describeStep('core.workflow_error')} />}
                  name={step.name}
                  kind="When a workflow fails · each workflow chooses its error workflow in its own Settings"
                  state={<StatusMark tone="success">On</StatusMark>}
                />
              ))
            : null}
          <TriggerRow
            label="By hand"
            icon={<StepTile step={describeStep('core.manual')} />}
            name="By hand"
            kind="Manual · anyone who can run this workflow fills its inputs, then starts it"
            state={
              <span className="text-meta text-subtle-foreground">
                Always on
              </span>
            }
          />
        </RowList>
        {editable ? null : (
          <p className="mt-3 text-meta text-subtle-foreground">
            Webhook addresses and deliveries are shown to{' '}
            {whoCan(WEBHOOK_CAPABILITY)}.
          </p>
        )}
        <p className="mt-3 text-meta text-subtle-foreground">
          Schedules can be switched off one by one. To stop webhooks and forms
          too, pause the workflow in{' '}
          <Link
            to="/w/$workspaceId/workflows/$workflowId/settings"
            params={{ workspaceId: workspace.id, workflowId }}
            className="inline-link"
          >
            Settings
          </Link>
          .
        </p>
        {editable ? (
          <p className="mt-1.5 text-meta text-subtle-foreground">
            Polling and “When a workflow fails” can start runs too. Add that
            trigger step in{' '}
            <Link
              to="/w/$workspaceId/workflows/$workflowId"
              params={{ workspaceId: workspace.id, workflowId }}
              className="inline-link"
            >
              Build
            </Link>
            , then publish.
          </p>
        ) : null}
      </section>
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
