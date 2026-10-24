import {
  RunPublicationReview,
  usePublicationReview,
} from './publication-review';
import { RunInputUpload } from './file-input';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { useCallback, useState } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import {
  InputCasesPanel,
  useInputCases,
  type LoadedInputCase,
} from '@/features/workflows/input-cases.public';
import type { ApiClient } from '@/lib/api/client';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { RunIntent } from '@/features/workflow-runs/commands.public';
import { useRunInput } from '@/features/workflow-runs/run-input.public';
import { DeadlineField } from '@/components/ui/deadline-field';
import { runInputAvailability } from '../../model/run-input/availability';
import { expectedRunVersion } from '../../model/run-input/version';

type RunInputDialogProps = Readonly<{
  open: boolean;
  pending: boolean;
  error: string | undefined;
  retryAvailable: boolean;
  onOpenChange: (open: boolean) => void;
  onStartNew: (intent: RunIntent) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
  publicationConflict?: boolean;
  onReviewPublication?: () => Promise<string>;
  recoveryIntent?: RunIntent | undefined;
  caseScope?: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
    workflow: WorkflowSummary;
  }>;
}>;

/**
 * Starts the published version with an input and an optional deadline,
 * picked with Weft's deadline control (none, in an hour, in a day, or a
 * date and time on the person's clock). After an uncertain start it offers
 * only the exact same command until its outcome is resolved.
 */
export function RunInputDialog(props: RunInputDialogProps) {
  if (props.caseScope === undefined)
    return <RunInputDialogContent {...props} />;
  return (
    <CaseRunInputDialog
      key={`${props.caseScope.userId}:${props.caseScope.workspace.id}:${props.caseScope.workflow.id}`}
      {...props}
      caseScope={props.caseScope}
    />
  );
}

function CaseRunInputDialog(
  props: RunInputDialogProps &
    Readonly<{ caseScope: NonNullable<RunInputDialogProps['caseScope']> }>,
) {
  const { apiClient, userId, workspace, workflow } = props.caseScope;
  const cases = useInputCases({
    api: apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId: workflow.id,
    canWrite:
      workspace.status === 'active' &&
      workflow.lifecycleStatus === 'active' &&
      workspace.capabilities.includes('workflow:update'),
    enabled: props.open,
  });
  return <RunInputDialogContent {...props} cases={cases} />;
}

type RunInputDialogContentProps = RunInputDialogProps &
  Readonly<{ cases?: ReturnType<typeof useInputCases> }>;

function RunInputDialogContent(props: RunInputDialogContentProps) {
  const model = useRunInputDialog(props);
  return (
    <ConfirmDialog
      open={model.open}
      onOpenChange={model.onOpenChange}
      title="Run with input"
      description={
        model.retryAvailable
          ? 'Retry sends the original input, deadline and version precondition (if any) within 24 hours of the first attempt. A replacement run is blocked until this outcome is resolved.'
          : 'This starts a real run of the published version. It can send messages and call other services.'
      }
      confirmLabel={
        model.retryAvailable ? 'Retry same run' : 'Start published version'
      }
      pendingLabel="Starting…"
      pending={model.pending}
      locked={model.availability.locked}
      confirmDisabled={model.availability.confirmDisabled}
      error={model.review.error ?? model.error}
      errorTone={model.retryAvailable ? 'warning' : 'destructive'}
      onConfirm={model.submit}
    >
      <RunPublicationReview
        expectedVersion={model.expectedVersion}
        loadedName={model.loaded?.name}
        staleCase={model.staleCase}
        retryAvailable={model.retryAvailable}
        review={model.review}
        publicationConflict={model.publicationConflict}
        canReview={model.onReviewPublication !== undefined}
        locked={model.availability.locked}
      />
      {model.open &&
      model.caseScope !== undefined &&
      model.cases !== undefined ? (
        <InputCasesPanel
          workspace={model.caseScope.workspace}
          workflow={model.caseScope.workflow}
          cases={model.cases}
          disabled={model.availability.fieldsBlocked}
          editing={model.caseEditing}
          onEditingChange={model.setCaseEditing}
          onAccessLost={model.hideCaseInput}
          onLoad={(value) => {
            model.review.clear();
            model.setLoaded(value);
            model.runInput.reset(JSON.stringify(value.input, null, 2));
          }}
        />
      ) : null}
      {model.caseAccessLost ? null : (
        <FieldGroup>
          <LabelledField
            id="run-input"
            label="Run input (JSON)"
            description="Use {} if the workflow doesn’t read any input."
            error={model.runInput.validation.error('input')}
          >
            {(control) => (
              <Textarea
                {...control}
                ref={model.runInput.validation.register('input')}
                name="run-input"
                autoComplete="off"
                spellCheck={false}
                className="min-h-32 font-mono text-base md:text-[0.8rem]"
                disabled={model.availability.fieldsBlocked}
                value={model.runInput.input}
                onChange={(event) => {
                  model.runInput.changeInput(event.currentTarget.value);
                }}
              />
            )}
          </LabelledField>
          {model.open ? (
            <RunInputUpload
              scope={model.caseScope}
              versionId={model.expectedVersion}
              input={model.runInput.input}
              disabled={model.availability.fieldsBlocked || model.caseEditing}
              onChange={model.runInput.changeInput}
            />
          ) : null}
          <DeadlineField
            value={model.runInput.deadline}
            error={model.runInput.validation.error('deadline')}
            disabled={model.availability.fieldsBlocked}
            register={model.runInput.validation.register('deadline')}
            onChange={model.runInput.changeDeadline}
          />
        </FieldGroup>
      )}
    </ConfirmDialog>
  );
}

function useRunInputDialog({
  open,
  pending,
  error,
  retryAvailable,
  onOpenChange,
  onStartNew,
  onRetry,
  caseScope,
  publicationConflict = false,
  onReviewPublication,
  recoveryIntent,
  cases,
}: RunInputDialogContentProps) {
  const runInput = useRunInput();
  const [loaded, setLoaded] = useState<LoadedInputCase>();
  const caseLocked = cases !== undefined && (cases.pending || cases.uncertain);
  const [caseEditing, setCaseEditing] = useState(false);
  const [caseAccessLost, setCaseAccessLost] = useState(false);
  const [submittedVersion, setSubmittedVersion] = useState<string>();
  const review = usePublicationReview({
    read: onReviewPublication,
    displayedVersionId: caseScope?.workflow.publishedVersionId,
    recovering: retryAvailable,
  });
  const hideCaseInput = useCallback(() => {
    setCaseAccessLost(true);
    setLoaded(undefined);
  }, []);
  const expectedVersion = expectedRunVersion({
    retryAvailable,
    recoveryVersion: recoveryIntent?.expectedPublishedVersionId,
    loadedCaseVersion: loaded?.workflowVersionId,
    reviewedVersion: review.target,
    submittedVersion,
    publishedVersion: caseScope?.workflow.publishedVersionId,
  });
  const staleCase =
    loaded !== undefined &&
    loaded.workflowVersionId !== caseScope?.workflow.publishedVersionId;
  const availability = runInputAvailability({
    pending,
    retryAvailable,
    publicationConflict,
    workflow: caseScope?.workflow,
    cases: {
      locked: caseLocked,
      editing: caseEditing,
      accessLost: caseAccessLost,
      stale: staleCase,
    },
    review,
  });

  async function startNew() {
    const intent = runInput.read();
    if (availability.confirmDisabled || pending) return;
    if (intent === undefined) return;
    setSubmittedVersion(expectedVersion);
    if (
      await onStartNew({
        ...intent,
        ...(expectedVersion === undefined
          ? {}
          : { expectedPublishedVersionId: expectedVersion }),
      })
    )
      onOpenChange(false);
  }

  async function submit() {
    if (availability.confirmDisabled || pending) return;
    if (!retryAvailable) {
      await startNew();
      return;
    }
    if (await onRetry()) onOpenChange(false);
  }

  return {
    open,
    onOpenChange,
    retryAvailable,
    pending,
    availability,
    review,
    error,
    submit,
    expectedVersion,
    loaded,
    staleCase,
    publicationConflict,
    onReviewPublication,
    caseScope,
    cases,
    caseEditing,
    setCaseEditing,
    hideCaseInput,
    setLoaded,
    runInput,
    caseAccessLost,
  } as const;
}
