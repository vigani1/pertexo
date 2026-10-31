import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { WorkspaceVariableUsageResponse } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import { isAccessLost, readFailureReason } from '@/lib/api/error-copy';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import {
  useVariableUsageCheck,
  type UsageCheckPhase,
} from '../hooks/use-usage-check';
type UsageRow = WorkspaceVariableUsageResponse['items'][number];

function emptySentence(phase: UsageCheckPhase, incomplete: boolean): string {
  if (phase !== 'finished')
    return 'No references in the workflows checked so far.';
  if (incomplete) return 'No parsed reference found; the check is incomplete.';
  return 'No current draft or publication references this name.';
}

const count = (value: number) => value.toLocaleString(FORMAT_LOCALE);

/** Hidden workflows aren't checked, so every sentence says whose view this is. */
function progressSentence(
  phase: UsageCheckPhase,
  counts: Readonly<{ checked: number; total: number }> | undefined,
): string {
  if (counts === undefined) return 'Checking workflows…';
  const { checked, total } = counts;
  if (phase === 'finished') {
    if (total === 0) return 'You can’t see any workflows to check.';
    return total === 1
      ? 'Checked the 1 workflow you can see.'
      : `Checked all ${count(total)} workflows you can see.`;
  }
  const seen = `${count(checked)} of ${count(total)} ${total === 1 ? 'workflow' : 'workflows'} you can see`;
  return phase === 'failed' ? `Stopped after ${seen}.` : `Checked ${seen}.`;
}

const PHASE_ANNOUNCEMENT: Readonly<Record<UsageCheckPhase, string>> = {
  checking: 'Checking workflows',
  finished: 'Check finished',
  failed: 'Check stopped',
};

/**
 * Stays in place once the check ends, so what's below it doesn't jump. Only the
 * check's start and end are announced: each new count would talk over the page.
 */
function UsageProgress({
  phase,
  counts,
}: Readonly<{
  phase: UsageCheckPhase;
  counts: Readonly<{ checked: number; total: number }> | undefined;
}>) {
  // A finished check fills the bar, even with no workflows to count.
  const max = Math.max(counts?.total ?? 0, 1);
  const now = phase === 'finished' ? max : (counts?.checked ?? 0);
  const sentence = progressSentence(phase, counts);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label="Workflows checked"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={now}
        aria-valuetext={sentence}
        className="relative h-1 overflow-hidden rounded-full bg-surface-ink/[0.07]"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-action/80 transition-[width] duration-300 ease-unspool motion-reduce:transition-none"
          style={{ width: `${String((now / max) * 100)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">{sentence}</p>
      <span role="status" className="sr-only">
        {PHASE_ANNOUNCEMENT[phase]}
      </span>
    </div>
  );
}

function UsageRows({
  scope,
  rows,
  incomplete,
  phase,
}: Readonly<{
  scope: WorkspaceApiScope;
  rows: readonly UsageRow[];
  incomplete: boolean;
  phase: UsageCheckPhase;
}>) {
  return (
    <>
      {incomplete ? (
        <Notice tone="warning">
          Some draft expressions are invalid and could not be analysed. Fix them
          before relying on this check.
        </Notice>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm">{emptySentence(phase, incomplete)}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <li key={`${row.workflowId}:${row.id}`} className="py-3 text-sm">
              <Link
                className="text-action underline underline-offset-4"
                to="/w/$workspaceId/workflows/$workflowId"
                params={{
                  workspaceId: scope.workspaceId,
                  workflowId: row.workflowId,
                }}
              >
                {row.workflowName}
              </Link>
              <p className="mt-1 break-words text-muted-foreground">
                {row.stage === 'draft' ? 'Draft' : 'Published'}
                {row.archived ? ' · archived' : ''} · {row.label} → {row.input}
              </p>
              {row.kind === 'dynamic' ? (
                <p className="text-xs text-muted-foreground">
                  Computed lookup or whole-map expression; may use any variable.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function VariableUsage({
  scope,
  name,
  onRemove,
}: Readonly<{
  scope: WorkspaceApiScope;
  name: string;
  onRemove?: () => void;
}>) {
  const { query, phase, workflowChanged, resume } = useVariableUsageCheck(
    scope,
    name,
  );
  const lastPage = query.data?.pages.at(-1);
  // A first read that failed, or lost access, is QueryView's to explain.
  const stoppedPartway =
    query.isFetchNextPageError && !isAccessLost(query.error);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Current drafts and current publications, including archived workflows.
        Retained historical versions and run snapshots keep their own values.
      </p>
      {phase === 'failed' && lastPage === undefined ? null : (
        <UsageProgress
          phase={phase}
          counts={
            lastPage === undefined
              ? undefined
              : {
                  checked: lastPage.checkedWorkflows,
                  total: lastPage.totalWorkflows,
                }
          }
        />
      )}
      <QueryView query={query} resource="Workflow references">
        {(data) => (
          <UsageRows
            scope={scope}
            rows={data.pages.flatMap((page) => page.items)}
            incomplete={data.pages.some((page) => page.incomplete)}
            phase={phase}
          />
        )}
      </QueryView>
      {phase === 'failed' && stoppedPartway ? (
        <Notice
          tone="destructive"
          action={
            <Button type="button" variant="outline" size="sm" onClick={resume}>
              {workflowChanged ? 'Restart check' : 'Try again'}
            </Button>
          }
        >
          {workflowChanged
            ? 'A workflow changed while it was being checked. Restart the check for current results.'
            : readFailureReason(query.error)}
        </Notice>
      ) : null}
      {onRemove === undefined ? null : (
        <>
          <Notice tone="warning">
            {phase === 'failed'
              ? 'This check didn’t finish, so workflows it didn’t reach may still use this name. New runs that require it will fail; existing snapshots stay unchanged.'
              : 'Removing a name does not rewrite these references. New runs that require it will fail; existing snapshots stay unchanged.'}
          </Notice>
          <Button
            type="button"
            variant="destructive"
            disabled={phase === 'checking'}
            onClick={onRemove}
          >
            {phase === 'failed' ? 'Remove anyway' : 'Remove from draft'}
          </Button>
          {phase === 'checking' ? (
            <p className="text-xs text-muted-foreground">
              You can remove this name when the check finishes.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function VariableUsageDialog({
  scope,
  name,
  onClose,
  onRemove,
}: Readonly<{
  scope: WorkspaceApiScope;
  name: string;
  onClose: () => void;
  onRemove?: () => void;
}>) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <div className="mb-4 flex flex-col gap-2">
          <DialogTitle>References to {name}</DialogTitle>
          <DialogDescription>
            Check current uses before changing this shared name.
          </DialogDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-4"
          onClick={onClose}
        >
          Close references
        </Button>
        <VariableUsage
          scope={scope}
          name={name}
          {...(onRemove === undefined ? {} : { onRemove })}
        />
      </DialogContent>
    </Dialog>
  );
}
