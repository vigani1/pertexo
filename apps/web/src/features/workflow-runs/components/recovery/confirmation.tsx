import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { DeadlineField } from '@/components/ui/deadline-field';
import { Status } from '@/components/ui/status';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { formatDateTime } from '@/lib/format/time';
import { runDeadlineProblem } from '../../model/commands/run-intent';
import type { EligibleRecovery } from '../../model/commands/recovery';
import type { useRunRecovery } from '../../data/mutations/use-run-recovery';
type RecoveryCommand = ReturnType<typeof useRunRecovery>;
export function RecoveryConfirmation({
  preview,
  command,
  open,
  onOpenChange,
}: Readonly<{
  preview: EligibleRecovery;
  command: RecoveryCommand;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const [deadline, setDeadline] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const validation = useFieldValidation<'deadline'>();
  const possible = preview.effectRisk === 'possible_effects';
  const unknown = preview.effectRisk === 'unknown_outcome';
  const needsAcknowledgement = possible || unknown;
  const locked = command.pending || command.unconfirmed;
  async function confirm() {
    if (command.unconfirmed) {
      await command.retry();
      return;
    }
    if (!validation.submit({ deadline: runDeadlineProblem(deadline) })) return;
    const trimmed = deadline.trim();
    const accepted = await command.startNew({
      workflowVersionId: preview.workflowVersionId,
      nodeRunId: preview.nodeRunId,
      ...(trimmed === ''
        ? {}
        : { deadlineAt: new Date(trimmed).toISOString() }),
      ...(possible && acknowledged
        ? { acknowledgePossibleEffects: true as const }
        : {}),
      ...(unknown && acknowledged
        ? { acknowledgeUnknownOutcome: true as const }
        : {}),
    });
    if (accepted) onOpenChange(false);
  }
  const idleConfirmLabel = needsAcknowledgement
    ? 'Retry anyway'
    : 'Retry from this step';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Retry from this step"
      description={
        <span className="break-words">
          Start a new run of v{String(preview.versionNumber)} at{' '}
          {preview.nodeLabel ?? preview.nodeId}. Earlier steps use their saved
          results. This step and later steps run again with current connections.
        </span>
      }
      confirmLabel={
        command.unconfirmed ? 'Retry same request' : idleConfirmLabel
      }
      pendingLabel="Checking acceptance…"
      pending={command.pending}
      confirmDisabled={
        command.expired ||
        (!command.unconfirmed && needsAcknowledgement && !acknowledged)
      }
      error={command.error}
      errorTone={command.unconfirmed ? 'warning' : 'destructive'}
      onConfirm={confirm}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Status tone="success">
          {String(preview.reusedCount)} earlier{' '}
          {preview.reusedCount === 1 ? 'step' : 'steps'} reused
        </Status>
        <span className="text-muted-foreground">
          Saved {formatDateTime(preview.sourceCompletedAt)}
        </span>
      </div>
      {needsAcknowledgement ? (
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={acknowledged}
            disabled={locked}
            onCheckedChange={setAcknowledged}
          />
          <span>
            {unknown
              ? "We don't know whether this step reached the service. Retrying can repeat its effect. I want to retry it anyway."
              : 'This step reached the service and may have partly taken effect. I want to retry it anyway.'}
          </span>
        </label>
      ) : null}
      <DeadlineField
        value={deadline}
        error={validation.error('deadline')}
        disabled={locked}
        register={validation.register('deadline')}
        onChange={(text) => {
          setDeadline(text);
          validation.change('deadline', runDeadlineProblem(text));
        }}
      />
      {command.unconfirmed ? (
        <p className="text-sm text-muted-foreground">
          The same request is kept while this run page stays open, including
          when you close this dialog. Retrying checks acceptance. It does not
          request a second run. Reloading or leaving loses this in-memory
          request.
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
