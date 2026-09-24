import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';
import { AuthStatusLine } from '@/features/auth/auth-stage.public';
import type { AcceptanceFailure } from '../model/acceptance-failure';

/**
 * What went wrong and the safe next step. Uncertain outcomes offer a status
 * check (never a second acceptance); a lost session offers the invitation's
 * own sign-in again.
 */
export function AcceptanceFailureLine({
  error,
  journey,
  pending,
  tokenAvailable,
  onReconcile,
  onSignIn,
  onOpenWorkspace,
  onDiscover,
  onRetry,
}: Readonly<{
  error: AcceptanceFailure;
  journey: InvitationAcceptanceJourney | undefined;
  pending: boolean;
  tokenAvailable: boolean;
  onReconcile: () => void;
  onSignIn: () => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onDiscover: () => void;
  onRetry: () => void;
}>) {
  const checkable =
    error.kind === 'authentication' ||
    error.kind === 'uncertain' ||
    error.kind === 'verification';
  const canSignIn =
    (error.kind === 'authentication' || error.kind === 'verification') &&
    journey !== undefined &&
    journey.state !== 'unavailable';
  const openable = error.kind === 'cleanup' && journey?.state === 'completed';
  const hasActions =
    checkable || canSignIn || openable || journey === undefined;
  return (
    <AuthStatusLine
      tone={
        error.kind === 'uncertain' || error.kind === 'cleanup'
          ? 'attention'
          : 'failure'
      }
      className="mt-5"
      action={
        hasActions ? (
          <div className="mt-1 flex flex-wrap gap-2">
            {checkable ? (
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
            {canSignIn ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={pending}
                onClick={onSignIn}
              >
                {error.kind === 'verification'
                  ? 'Verify invited account again'
                  : 'Sign in again'}
              </Button>
            ) : null}
            {error.kind === 'cleanup' && journey?.state === 'completed' ? (
              <>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => {
                    onOpenWorkspace(journey.workspace.id);
                  }}
                >
                  Open workspace
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onDiscover}
                >
                  Go to my workspaces
                </Button>
              </>
            ) : null}
            {journey === undefined ? (
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
        ) : undefined
      }
    >
      {error.message}
    </AuthStatusLine>
  );
}
