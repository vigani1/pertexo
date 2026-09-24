import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import {
  failureNextSteps,
  type AcceptanceFailure,
  type FailureNextSteps,
} from '../model/acceptance-failure';

type Handlers = Readonly<{
  pending: boolean;
  tokenAvailable: boolean;
  onReconcile: () => void;
  onSignIn: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onDiscover: () => void;
  onRetry: () => void;
}>;

function NextSteps({
  steps,
  pending,
  tokenAvailable,
  onReconcile,
  onSignIn,
  onOpenWorkspace,
  onDiscover,
  onRetry,
}: Handlers & Readonly<{ steps: FailureNextSteps }>) {
  const { openWorkspaceId } = steps;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {steps.checkStatus ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onReconcile}
        >
          Check status
        </Button>
      ) : null}
      {steps.signIn === undefined ? null : (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={pending}
          onClick={onSignIn}
        >
          {steps.signIn === 'verification'
            ? 'Verify invited account again'
            : 'Sign in again'}
        </Button>
      )}
      {openWorkspaceId === undefined ? null : (
        <>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              onOpenWorkspace(openWorkspaceId);
            }}
          >
            Open workspace
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDiscover}>
            Go to my workspaces
          </Button>
        </>
      )}
      {steps.retry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onRetry}
        >
          {tokenAvailable ? 'Try the link again' : 'Try again'}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * What went wrong and the safe next step. Uncertain outcomes offer a status
 * check (never a second acceptance); a lost session offers the invitation's
 * own sign-in again.
 */
export function AcceptanceFailureLine({
  error,
  journey,
  ...handlers
}: Handlers &
  Readonly<{
    error: AcceptanceFailure;
    journey: InvitationAcceptanceJourney | undefined;
  }>) {
  const steps = failureNextSteps(
    error,
    journey === undefined
      ? undefined
      : {
          state: journey.state,
          workspaceId:
            journey.state === 'completed' ? journey.workspace.id : undefined,
        },
  );
  const hasSteps =
    steps.checkStatus ||
    steps.signIn !== undefined ||
    steps.openWorkspaceId !== undefined ||
    steps.retry;
  return (
    <Notice
      tone={
        error.kind === 'uncertain' || error.kind === 'cleanup'
          ? 'warning'
          : 'destructive'
      }
      className="mt-5"
      action={hasSteps ? <NextSteps steps={steps} {...handlers} /> : undefined}
    >
      {error.message}
    </Notice>
  );
}
