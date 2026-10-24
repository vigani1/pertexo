import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import type { WorkflowCommandSession } from '../../hooks/use-workflow-command-session';
import { RunMenu } from './menu';
export function PublishedRunAction({
  form,
  canRun,
  submission,
  published,
  loading,
  onRunNow,
  onRunWithInput,
  scope,
}: Readonly<{
  form: boolean;
  canRun: boolean;
  submission: WorkflowCommandSession['runSubmission'];
  published: boolean;
  loading: boolean;
  onRunNow: () => void;
  onRunWithInput: () => void;
  scope: Readonly<{ workspaceId: string; workflowId: string }>;
}>) {
  const { workspaceId, workflowId } = scope;

  if (
    form &&
    !submission.retryAvailable &&
    submission.acceptedRunId === undefined
  )
    return (
      <Link
        to="/w/$workspaceId/forms/$workflowId"
        params={{ workspaceId, workflowId }}
        className={buttonVariants({
          size: 'sm',
          variant: 'outline',
          className: 'max-sm:w-20 max-sm:shrink-0',
        })}
        aria-label="Open workflow form"
      >
        <span className="hidden sm:inline">Open form</span>
        <span className="sm:hidden" aria-hidden="true">
          Form
        </span>
      </Link>
    );
  if (!canRun) return null;
  return (
    <RunMenu
      published={published}
      pending={submission.pending || loading}
      acceptedRunPending={submission.acceptedRunId !== undefined}
      unresolvedRun={submission.retryAvailable}
      onRunNow={onRunNow}
      onRunWithInput={onRunWithInput}
      onOpenAcceptedRun={() => void submission.openAcceptedRun()}
    />
  );
}
