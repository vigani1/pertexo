import { isAdministrativeRole } from '@pertexo/workflow-model';
import { AudienceMoveReview } from './folders/audience-review';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { WorkflowOrganizationOutcomes } from './outcomes';
import type { Props } from './use-edit';
import { useOrganizationEdit } from './use-edit';
import { OrganizationFields } from './fields';

const RECOVERY =
  'Exact recovery is available for 24 hours, not an indefinite duplicate-prevention guarantee. Refreshing current state preserves an unresolved request; only a known outcome permits a fresh change. Reloading this page loses its in-memory recovery.';

export function WorkflowOrganizationDialog(props: Props) {
  const editor = useOrganizationEdit(props);
  const { selected, selectionValid, command, reading, locked, feedback } =
    editor;
  const { workspace, onClose } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          Organize{' '}
          {selected.length === 1
            ? 'workflow'
            : `${String(selected.length)} workflows`}
        </DialogTitle>
        <DialogDescription>
          Only these explicitly selected workflows are changed. Folder and tag
          changes do not publish, run or reorder workflows.
        </DialogDescription>
        <div className="mt-5 flex flex-col gap-5">
          {command.denied ? null : (
            <ul
              aria-label="Selected workflows"
              className="text-sm break-words text-muted-foreground"
            >
              {selected.map(({ workflow }) => (
                <li key={workflow.id}>{workflow.name}</li>
              ))}
            </ul>
          )}
          {!selectionValid ? (
            <Notice tone="destructive">
              Select 1–50 distinct workflows. No implicit selection of unloaded
              workflows is supported.
            </Notice>
          ) : null}
          {feedback === undefined ? null : (
            <Notice
              role="alert"
              tone={command.retryAvailable ? 'warning' : 'destructive'}
            >
              {feedback}
            </Notice>
          )}
          {command.denied || !reading ? null : (
            <Notice>Reading current organization…</Notice>
          )}
          {editor.audience.error ? (
            <Notice tone="warning">{editor.audience.error}</Notice>
          ) : null}
          {editor.audience.review ? (
            <AudienceMoveReview
              key={editor.audience.review.report.items
                .map((item) => item.token)
                .join(':')}
              report={editor.audience.review.report}
              administrator={isAdministrativeRole(workspace.role)}
              pending={command.pending}
              onConfirm={() => {
                void editor.audience.confirm();
              }}
              onCancel={editor.audience.cancel}
            />
          ) : null}
          <OrganizationEditForm editor={editor} workspace={workspace} />
          <OrganizationEditResult editor={editor} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {RECOVERY}
          </p>
          <OrganizationRecoveryActions editor={editor} onClose={onClose} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrganizationEditForm({
  editor,
  workspace,
}: Readonly<{
  editor: ReturnType<typeof useOrganizationEdit>;
  workspace: AccessibleWorkspace;
}>) {
  const {
    command,
    selectionValid,
    current,
    selected,
    folders,
    tags,
    formEpoch,
    preparing,
    locked,
    reading,
    failedRead,
    confirm,
  } = editor;
  return (
    <>
      {command.denied ||
      !selectionValid ||
      current.length !== selected.length ||
      folders.data === undefined ||
      tags.data === undefined ? null : (
        <OrganizationFields
          key={formEpoch}
          workspace={workspace}
          workflows={current}
          folders={folders.data.items}
          tags={tags.data.pages.flatMap((page) => page.items)}
          pending={preparing || command.pending}
          locked={
            locked ||
            reading ||
            failedRead ||
            command.error !== undefined ||
            command.result !== undefined
          }
          onConfirm={confirm}
        />
      )}
    </>
  );
}

function OrganizationEditResult({
  editor,
}: Readonly<{ editor: ReturnType<typeof useOrganizationEdit> }>) {
  const { command, selected } = editor;
  if (command.result === undefined) return null;
  if ('items' in command.result)
    return (
      <WorkflowOrganizationOutcomes
        items={command.result.items.filter(
          (item) => item.status !== 'detached',
        )}
        workflows={command.denied ? [] : selected}
      />
    );
  return (
    <Notice tone="success">
      Organization command accepted. Current metadata is refreshed separately.
    </Notice>
  );
}

function OrganizationRecoveryActions({
  editor,
  onClose,
}: Readonly<{
  editor: ReturnType<typeof useOrganizationEdit>;
  onClose: () => void;
}>) {
  const { command, tags, preparing, locked, refresh } = editor;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" disabled={locked} onClick={onClose}>
        Close
      </Button>
      {tags.hasNextPage && !command.denied ? (
        <ProgressButton
          variant="ghost"
          pending={tags.isFetchingNextPage}
          pendingLabel="Loading tags…"
          disabled={locked}
          onClick={() => {
            void tags.fetchNextPage();
          }}
        >
          Load more tags
        </ProgressButton>
      ) : null}
      {command.retryAvailable ? (
        <ProgressButton
          pending={command.pending}
          pendingLabel="Retrying…"
          disabled={preparing}
          onClick={() => {
            void command.retry();
          }}
        >
          Retry original request
        </ProgressButton>
      ) : null}
      {command.denied ? null : (
        <ProgressButton
          variant="outline"
          pending={preparing}
          pendingLabel="Refreshing…"
          disabled={command.pending}
          onClick={() => {
            void refresh();
          }}
        >
          {command.retryAvailable
            ? 'Refresh current state'
            : 'Refresh for a new change'}
        </ProgressButton>
      )}
    </div>
  );
}
