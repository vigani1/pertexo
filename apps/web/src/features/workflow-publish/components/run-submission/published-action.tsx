import { Link } from '@tanstack/react-router';
import {
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { WorkflowCommandSession } from '../../hooks/use-workflow-command-session';

/** Published actions sit beside draft test actions in the Build menu. */
type PublishedRunMenuProps = Readonly<{
  form: boolean;
  canRun: boolean;
  submission: WorkflowCommandSession['runSubmission'];
  published: boolean;
  loading: boolean;
  onRunNow: () => void;
  onRunWithInput: () => void;
  scope: Readonly<{ workspaceId: string; workflowId: string }>;
}>;

export function PublishedRunMenuItems(props: PublishedRunMenuProps) {
  return (
    <>
      <DropdownMenuSeparator />
      {publishedRunCommands(props)}
    </>
  );
}

function publishedRunCommands({
  form,
  canRun,
  submission,
  published,
  loading,
  onRunNow,
  onRunWithInput,
  scope,
}: PublishedRunMenuProps) {
  const pending = submission.pending || loading;
  if (submission.retryAvailable) {
    return (
      <DropdownMenuItem disabled={pending} onClick={onRunWithInput}>
        Recover unconfirmed run
      </DropdownMenuItem>
    );
  }
  if (submission.acceptedRunId !== undefined) {
    return (
      <DropdownMenuItem
        disabled={pending}
        onClick={() => void submission.openAcceptedRun()}
      >
        Open accepted run
      </DropdownMenuItem>
    );
  }
  if (form) {
    return (
      <DropdownMenuLinkItem
        render={<Link to="/w/$workspaceId/forms/$workflowId" params={scope} />}
      >
        Open workflow form
      </DropdownMenuLinkItem>
    );
  }
  if (!canRun) return null;
  if (!published)
    return <DropdownMenuItem disabled>Run (publish first)</DropdownMenuItem>;
  return (
    <>
      <DropdownMenuItem disabled={pending} onClick={onRunNow}>
        Run published version
      </DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onRunWithInput}>
        Run with input…
      </DropdownMenuItem>
    </>
  );
}
