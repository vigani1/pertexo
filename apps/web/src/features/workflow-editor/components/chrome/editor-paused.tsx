import { Link } from '@tanstack/react-router';
import { ShieldAlertIcon } from 'lucide-react';
import { ProgressButton } from '@/components/ui/progress-button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  SystemState,
  SystemStateActions,
  SystemStateArt,
  SystemStateDescription,
  SystemStateTitle,
} from '@/components/patterns/system-state';

/**
 * The editor stops when it can't confirm who is signed in. Nothing is saved
 * under another or unverified account; verifying again resumes where you were.
 */
export function EditorPaused({
  reason,
  verifying,
  workspaceId,
  onVerify,
}: Readonly<{
  reason: 'changed' | 'unverified';
  verifying: boolean;
  workspaceId: string;
  onVerify: () => void;
}>) {
  return (
    <div className="grid min-h-svh place-items-center px-4">
      <SystemState>
        <SystemStateArt>
          <ShieldAlertIcon
            aria-hidden="true"
            className="size-10 text-warning"
          />
        </SystemStateArt>
        <SystemStateTitle>Editor paused</SystemStateTitle>
        <SystemStateDescription>
          {reason === 'changed'
            ? 'A different account signed in while this workflow was open.'
            : 'We couldn’t confirm you’re still signed in to this account.'}{' '}
          Saving stopped so nothing lands under the wrong account. Your changes
          are still here.
        </SystemStateDescription>
        <SystemStateActions>
          <ProgressButton
            type="button"
            pending={verifying}
            pendingLabel="Verifying…"
            onClick={onVerify}
          >
            Verify original account
          </ProgressButton>
          <Link
            to="/w/$workspaceId/workflows"
            params={{ workspaceId }}
            className={buttonVariants({ variant: 'ghost' })}
          >
            Return to workspace
          </Link>
        </SystemStateActions>
      </SystemState>
    </div>
  );
}
