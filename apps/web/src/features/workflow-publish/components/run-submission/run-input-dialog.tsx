import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { runInputAvailability } from '../../model/run-input-availability';
import { expectedRunVersion } from '../../model/run-input-version';

/** A fetched confirmation target must also reach the displayed Query snapshot. */
function usePublicationReview(
  read: (() => Promise<string>) | undefined,
  displayedVersionId: string | null | undefined,
  recovering: boolean,
) {
  const [target, setTarget] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const ready = target !== undefined && target === displayedVersionId;
  async function review() {
    if (read === undefined || pending) return;
    setPending(true);
    try {
      setTarget(await read());
      setError(undefined);
    } catch {
      setError(
        'The current publication couldn’t be read. Try reviewing again; no run has started.',
      );
    } finally {
      setPending(false);
    }
  }
  return {
    target,
    pending,
    error,
    ready,
    waiting: target !== undefined && !ready && !recovering,
    review,
    clear: () => {
      setTarget(undefined);
    },
  };
}

function RunVersionNotice({
  expectedVersion,
  loadedName,
  stale,
  recovering,
}: Readonly<{
  expectedVersion: string | undefined;
  loadedName: string | undefined;
  stale: boolean;
  recovering: boolean;
}>) {
  if (expectedVersion === undefined) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {recovering
        ? 'Original submitted version'
        : loadedName === undefined
          ? 'Current published version'
          : `Loaded case: ${loadedName}`}{' '}
      · <span className="break-all font-mono">{expectedVersion}</span>.{' '}
      {recovering
        ? 'This exact retry may recover a run already accepted on this version. It never substitutes the current publication.'
        : stale
          ? 'This case belongs to an older version. Review the current publication and create or load a new case; it will not be rebound automatically.'
          : 'The server will reject a changed publication instead of starting another version.'}
    </p>
  );
}

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
  const cases = useInputCases(
    apiClient,
    userId,
    workspace.id,
    workflow.id,
    workspace.status === 'active' &&
      workflow.lifecycleStatus === 'active' &&
      workspace.capabilities.includes('workflow:update'),
    props.open,
  );
  return <RunInputDialogContent {...props} cases={cases} />;
}

function RunInputDialogContent({
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
}: RunInputDialogProps &
  Readonly<{ cases?: ReturnType<typeof useInputCases> }>) {
  const runInput = useRunInput();
  const [loaded, setLoaded] = useState<LoadedInputCase>();
  const caseLocked = cases !== undefined && (cases.pending || cases.uncertain);
  const [caseEditing, setCaseEditing] = useState(false);
  const [caseAccessLost, setCaseAccessLost] = useState(false);
  const [submittedVersion, setSubmittedVersion] = useState<string>();
  const review = usePublicationReview(
    onReviewPublication,
    caseScope?.workflow.publishedVersionId,
    retryAvailable,
  );
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

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run with input"
      description={
        retryAvailable
          ? 'Retry sends the original input, deadline and version precondition (if any) within 24 hours of the first attempt. A replacement run is blocked until this outcome is resolved.'
          : 'This starts a real workflow run, not a test. It can send messages, make requests and create other external effects. Confirm the input and published version before starting.'
      }
      confirmLabel={
        retryAvailable ? 'Retry same run' : 'Start published version'
      }
      pendingLabel="Starting…"
      pending={pending}
      locked={availability.locked}
      confirmDisabled={availability.confirmDisabled}
      error={review.error ?? error}
      errorTone={retryAvailable ? 'warning' : 'destructive'}
      onConfirm={submit}
    >
      <RunPublicationReview
        expectedVersion={expectedVersion}
        loadedName={loaded?.name}
        staleCase={staleCase}
        retryAvailable={retryAvailable}
        review={review}
        publicationConflict={publicationConflict}
        canReview={onReviewPublication !== undefined}
        locked={availability.locked}
      />
      {open && caseScope !== undefined && cases !== undefined ? (
        <InputCasesPanel
          workspace={caseScope.workspace}
          workflow={caseScope.workflow}
          cases={cases}
          disabled={availability.fieldsBlocked}
          editing={caseEditing}
          onEditingChange={setCaseEditing}
          onAccessLost={hideCaseInput}
          onLoad={(value) => {
            review.clear();
            setLoaded(value);
            runInput.reset(JSON.stringify(value.input, null, 2));
          }}
        />
      ) : null}
      {caseAccessLost ? null : (
        <FieldGroup>
          <LabelledField
            id="run-input"
            label="Run input (JSON)"
            description="Use {} if the workflow doesn’t read any input."
            error={runInput.validation.error('input')}
          >
            {(control) => (
              <Textarea
                {...control}
                ref={runInput.validation.register('input')}
                name="run-input"
                autoComplete="off"
                spellCheck={false}
                className="min-h-32 font-mono text-[0.8rem]"
                disabled={availability.fieldsBlocked}
                value={runInput.input}
                onChange={(event) => {
                  runInput.changeInput(event.currentTarget.value);
                }}
              />
            )}
          </LabelledField>
          <DeadlineField
            value={runInput.deadline}
            error={runInput.validation.error('deadline')}
            disabled={availability.fieldsBlocked}
            register={runInput.validation.register('deadline')}
            onChange={runInput.changeDeadline}
          />
        </FieldGroup>
      )}
    </ConfirmDialog>
  );
}

function RunPublicationReview({
  expectedVersion,
  loadedName,
  staleCase,
  retryAvailable,
  review,
  publicationConflict,
  canReview,
  locked,
}: Readonly<{
  expectedVersion: string | undefined;
  loadedName: string | undefined;
  staleCase: boolean;
  retryAvailable: boolean;
  review: ReturnType<typeof usePublicationReview>;
  publicationConflict: boolean;
  canReview: boolean;
  locked: boolean;
}>) {
  return (
    <>
      <RunVersionNotice
        expectedVersion={expectedVersion}
        loadedName={loadedName}
        stale={staleCase}
        recovering={retryAvailable}
      />
      {staleCase && review.ready && !retryAvailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reviewed current publication ·{' '}
          <span className="break-all font-mono">{review.target}</span>. Create
          and load a new case for this version before confirming a real run. The
          loaded case stays bound to its original version.
        </p>
      ) : null}
      {review.waiting ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for the reviewed publication to appear. Case changes and new
          starts stay blocked until the displayed version agrees.
        </p>
      ) : null}
      {(publicationConflict || review.waiting) && canReview ? (
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => void review.review()}
        >
          Read current publication and review copied input
        </Button>
      ) : null}
    </>
  );
}
