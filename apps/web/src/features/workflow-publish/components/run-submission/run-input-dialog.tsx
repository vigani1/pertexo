import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import {
  InputCasesPanel,
  type LoadedInputCase,
} from '@/features/workflows/input-cases.public';
import type { ApiClient } from '@/lib/api/client';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { RunIntent } from '@/features/workflow-runs/commands.public';
import { useRunInput } from '@/features/workflow-runs/run-input.public';
import { DeadlineField } from '@/components/ui/deadline-field';

function publicationUnavailable(workflow: WorkflowSummary | undefined) {
  return (
    workflow !== undefined &&
    (workflow.publishedVersionId === null ||
      workflow.lifecycleStatus !== 'active')
  );
}

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

/**
 * Starts the published version with an input and an optional deadline,
 * picked with Weft's deadline control (none, in an hour, in a day, or a
 * date and time on the person's clock). After an uncertain start it offers
 * only the exact same command until its outcome is resolved.
 */
export function RunInputDialog({
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
}: Readonly<{
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
}>) {
  const runInput = useRunInput();
  const [loaded, setLoaded] = useState<LoadedInputCase>();
  const [caseLocked, setCaseLocked] = useState(false);
  const [caseEditing, setCaseEditing] = useState(false);
  const [caseAccessLost, setCaseAccessLost] = useState(false);
  const [submittedVersion, setSubmittedVersion] = useState<string>();
  const review = usePublicationReview(
    onReviewPublication,
    caseScope?.workflow.publishedVersionId,
    retryAvailable,
  );
  const reviewing = review.pending;
  const reviewMismatch = review.waiting;
  const hideCaseInput = useCallback(() => {
    setCaseAccessLost(true);
    setLoaded(undefined);
  }, []);
  // Never infer a new version for a frozen retry, including unchecked retries.
  const expectedVersion = retryAvailable
    ? recoveryIntent?.expectedPublishedVersionId
    : (loaded?.workflowVersionId ??
      review.target ??
      submittedVersion ??
      caseScope?.workflow.publishedVersionId ??
      undefined);
  const staleCase =
    loaded !== undefined &&
    loaded.workflowVersionId !== caseScope?.workflow.publishedVersionId;
  const blocked =
    pending || retryAvailable || caseLocked || reviewing || reviewMismatch;

  async function startNew() {
    const intent = runInput.read();
    if (
      staleCase ||
      caseLocked ||
      caseEditing ||
      publicationConflict ||
      reviewing ||
      reviewMismatch
    )
      return;
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
    if (caseEditing) return;
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
      locked={pending || caseLocked || reviewing}
      confirmDisabled={
        caseLocked ||
        caseEditing ||
        caseAccessLost ||
        publicationConflict ||
        reviewing ||
        reviewMismatch ||
        (!retryAvailable &&
          (staleCase || publicationUnavailable(caseScope?.workflow)))
      }
      error={review.error ?? error}
      errorTone={retryAvailable ? 'warning' : 'destructive'}
      onConfirm={submit}
    >
      <RunVersionNotice
        expectedVersion={expectedVersion}
        loadedName={loaded?.name}
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
      {reviewMismatch ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for the reviewed publication to appear. Case changes and new
          starts stay blocked until the displayed version agrees.
        </p>
      ) : null}
      {(publicationConflict || reviewMismatch) &&
      onReviewPublication !== undefined ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending || caseLocked || reviewing}
          onClick={() => void review.review()}
        >
          Read current publication and review copied input
        </Button>
      ) : null}
      {open && caseScope !== undefined ? (
        <InputCasesPanel
          {...caseScope}
          disabled={blocked}
          onLockedChange={setCaseLocked}
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
                disabled={blocked}
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
            disabled={blocked}
            register={runInput.validation.register('deadline')}
            onChange={runInput.changeDeadline}
          />
        </FieldGroup>
      )}
    </ConfirmDialog>
  );
}
