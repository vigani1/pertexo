import { ConfirmationDetails } from '@/components/patterns/actions/confirm-dialog';
import { unreachableStepIssues } from '../../model/validation/reachability';
import { groupWorkflowFindings } from '../../model/validation/issues';
import { publicationDialogCopy } from '../../model/publication/dialog-copy';
import type { ReactNode } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { ArrowUpFromLineIcon, MonitorIcon } from 'lucide-react';
import { useRef, useId } from 'react';
import { LabelledField, FieldGroup } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Status, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { PublishSummary } from '../../model/publication/summary';
import type { WorkflowIssueGroup } from '../../model/validation/issues';
import type { WorkflowValidationTarget } from '../../model/validation/target';
import type { PublishStage } from '../../data/mutations/use-workflow-publication';
import { IssuesList } from '../validation/issues-list';
import { PublishChanges } from './publish-changes';

const touchTargets =
  'flex h-[44rem] flex-col overflow-hidden max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11';

const stages: readonly Readonly<{ stage: PublishStage; label: string }>[] = [
  { stage: 'saving', label: 'Saving your last change' },
  { stage: 'checking', label: 'Checking for issues' },
  { stage: 'publishing', label: 'Making this version live' },
];

/**
 * What publishing will do before it happens: the change summary against
 * the live version, anything blocking it, and what happens to triggers and
 * runs already in progress. Confirming shows the real steps as they run.
 */
type PublishDialogProps = Readonly<{
  mode?: 'publish' | 'review';
  unavailable?: boolean;
  state: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  preview: Readonly<{
    versionLabel: string;
    summary: PublishSummary | undefined;
    summaryState: 'loading' | 'error' | 'ready';
    graph: WorkflowGraphContract;
    unchangedVersionNumber: number | undefined;
  }>;
  command: Readonly<{
    stage: PublishStage | undefined;
    error: string | undefined;
    recoveryPending: boolean;
    onPublish: (note?: string) => void;
  }>;
  issues: Readonly<{
    blockingGroups: readonly WorkflowIssueGroup[];
    onFix: (target: WorkflowValidationTarget) => void;
  }>;
  slots?: Readonly<{ suiteNotice?: ReactNode; policyNotice?: ReactNode }>;
}>;

export function PublishDialog({
  state: { open, onOpenChange },
  preview: {
    versionLabel,
    summary,
    summaryState,
    graph,
    unchangedVersionNumber,
  },
  command: { stage, error, recoveryPending, onPublish },
  issues: { blockingGroups, onFix },
  slots: { suiteNotice, policyNotice } = {},
  mode = 'publish',
  unavailable = false,
}: PublishDialogProps) {
  const pending = stage !== undefined;
  const noteId = useId();
  const fields = useFieldValues(
    {
      note: (value: string) =>
        value.trim().length >= 1 && value.trim().length <= 1000
          ? undefined
          : 'Add a note of 1 to 1,000 characters for the reviewer.',
    },
    { note: '' },
  );
  const requesting = mode === 'review';
  const copy = publicationDialogCopy({
    mode,
    pending,
    recoveryPending,
    failed: error !== undefined,
    versionLabel,
  });
  // Fix moves focus to the field it names; closing must not take it back.
  const fixing = useRef(false);
  function fix(target: WorkflowValidationTarget) {
    fixing.current = true;
    onOpenChange(false);
    onFix(target);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) fixing.current = false;
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn(touchTargets, pending && 'live-edge')}
        finalFocus={() => !fixing.current}
      >
        <DialogTitle className="shrink-0">{copy.title}</DialogTitle>
        <DialogDescription className="shrink-0">
          {copy.description}
        </DialogDescription>
        <div className="flex min-h-0 flex-1 flex-col">
          <ConfirmationDetails>
            {pending ? (
              <PublishProgress stage={stage} requesting={requesting} />
            ) : (
              <div className="mt-5 flex flex-col gap-5">
                {unchangedVersionNumber === undefined ||
                error !== undefined ? null : (
                  <Notice>
                    No changes since v{unchangedVersionNumber}. This version is
                    already live.
                  </Notice>
                )}
                {policyNotice}
                {requesting ? (
                  <FieldGroup>
                    <LabelledField
                      id={noteId}
                      label="Note for the reviewer"
                      error={fields.error('note')}
                      description="Explain what changed and what to check. This note stays on the request, outside audit metadata and email."
                    >
                      {(control) => (
                        <Textarea
                          {...control}
                          {...fields.control('note')}
                          maxLength={1000}
                          rows={3}
                          disabled={recoveryPending}
                        />
                      )}
                    </LabelledField>
                  </FieldGroup>
                ) : null}
                {suiteNotice}
                <UnconnectedStepWarnings graph={graph} onFix={fix} />
                <PublishChanges summary={summary} state={summaryState} />
                <BlockingPublicationIssues
                  groups={blockingGroups}
                  graph={graph}
                  onFix={fix}
                />
                {requesting ? (
                  <p className="text-sm text-muted-foreground">
                    The live version keeps running until an eligible reviewer
                    approves. An approval publishes only this saved draft; it
                    cannot include later edits.
                  </p>
                ) : (
                  <>
                    <RetiredWebhooks
                      names={summary?.retiredWebhookNames ?? []}
                    />
                    <WhatHappens
                      summary={summary}
                      versionLabel={versionLabel}
                    />
                  </>
                )}
                <p className="flex items-start gap-2 text-xs text-subtle-foreground lg:hidden">
                  <MonitorIcon aria-hidden="true" className="mt-px size-3.5" />
                  Publishing works here, but reviewing changes is easier on a
                  larger screen.
                </p>
              </div>
            )}
            {error === undefined ? null : (
              <Notice
                tone="destructive"
                className="mt-4 [overflow-wrap:anywhere]"
              >
                {error}
              </Notice>
            )}
          </ConfirmationDetails>
        </div>
        <PublishDialogActions
          copy={copy}
          pending={pending}
          disabled={
            unavailable ||
            blockingGroups.length > 0 ||
            unchangedVersionNumber !== undefined
          }
          onConfirm={() => {
            if (!requesting || recoveryPending) onPublish();
            else {
              const values = fields.validate();
              if (values !== undefined) onPublish(values.note.trim());
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PublishProgress({
  stage,
  requesting,
}: Readonly<{ stage: PublishStage; requesting: boolean }>) {
  const activeIndex = stages.findIndex(
    (candidate) => candidate.stage === stage,
  );
  return (
    <ol className="mt-5 flex flex-col gap-2.5" aria-label="Publishing steps">
      {stages.map((step, index) => {
        const tone: StatusTone = progressTone(index, activeIndex);
        return (
          <li
            key={step.stage}
            aria-current={index === activeIndex ? 'step' : undefined}
          >
            <Status
              tone={tone}
              className={cn(
                'text-sm font-medium',
                index > activeIndex && 'text-subtle-foreground',
              )}
            >
              {requesting && step.stage === 'publishing'
                ? 'Sending the exact draft for review'
                : step.label}
            </Status>
          </li>
        );
      })}
    </ol>
  );
}

/** A publish only ends a webhook's address by removing its step, so say so first. */
function RetiredWebhooks({ names }: Readonly<{ names: readonly string[] }>) {
  if (names.length === 0) return null;
  return (
    <Notice tone="warning">
      {joinNames(names)} {names.length === 1 ? 'is' : 'are'} removed, so{' '}
      {names.length === 1
        ? 'its webhook address stops'
        : 'their webhook addresses stop'}{' '}
      answering. Publishing a version with{' '}
      {names.length === 1 ? 'that step' : 'those steps'} again brings the same
      address back.
    </Notice>
  );
}

function WhatHappens({
  summary,
  versionLabel,
}: Readonly<{ summary: PublishSummary | undefined; versionLabel: string }>) {
  const triggers = summary?.triggerNames ?? [];
  return (
    <section aria-label="What happens next">
      <h3 className="text-sm font-semibold">What happens</h3>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
        <li>
          {triggers.length === 0
            ? `Runs you start after this use ${versionLabel}.`
            : `${joinNames(triggers)} ${triggers.length === 1 ? 'starts' : 'start'} ${versionLabel} once it’s live.`}
        </li>
        <li>
          Runs already in progress finish on the version they started with.
        </li>
      </ul>
    </section>
  );
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function progressTone(index: number, activeIndex: number): StatusTone {
  if (index < activeIndex) return 'success';
  if (index === activeIndex) return 'live';
  return 'queued';
}

function BlockingPublicationIssues({
  groups,
  graph,
  onFix,
}: Readonly<{
  groups: readonly WorkflowIssueGroup[];
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  if (groups.length === 0) return null;
  return (
    <section aria-label="Blocking issues">
      <h3 className="text-sm font-semibold text-destructive">
        Fix these first
      </h3>
      <div className="mt-2">
        <IssuesList groups={groups} graph={graph} onFix={onFix} />
      </div>
    </section>
  );
}

function UnconnectedStepWarnings({
  graph,
  onFix,
}: Readonly<{
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  const warnings = groupWorkflowFindings(unreachableStepIssues(graph));
  if (warnings.length === 0) return null;
  return (
    <section aria-label="Unconnected steps">
      <h3 className="text-sm font-semibold text-warning">
        These steps won't run
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        You can still publish this workflow.
      </p>
      <IssuesList groups={warnings} graph={graph} onFix={onFix} />
    </section>
  );
}

function PublishDialogActions({
  copy,
  pending,
  disabled,
  onConfirm,
}: Readonly<{
  copy: ReturnType<typeof publicationDialogCopy>;
  pending: boolean;
  disabled: boolean;
  onConfirm: () => void;
}>) {
  return (
    <DialogFooter className="mt-6 shrink-0">
      <DialogClose
        render={<Button type="button" variant="ghost" disabled={pending} />}
      >
        Cancel
      </DialogClose>
      <ProgressButton
        type="button"
        variant="primary"
        pending={pending}
        pendingLabel={copy.pendingLabel}
        icon={<ArrowUpFromLineIcon data-icon="inline-start" />}
        disabled={disabled}
        onClick={onConfirm}
      >
        {copy.confirmLabel}
      </ProgressButton>
    </DialogFooter>
  );
}
