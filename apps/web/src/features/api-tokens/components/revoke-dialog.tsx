import { useRef, useState } from 'react';
import type { ApiTokenMetadata } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import type { ApiClient } from '@/lib/api/client';
import { useTokenRevocation } from '../data/api-tokens.mutations';
import {
  tokenCommandFeedback,
  uncertainTokenOutcome,
} from '../model/token-copy';

export function RevokeTokenDialog({
  apiClient,
  userId,
  workspaceId,
  token,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  token: ApiTokenMetadata;
  onClose: () => void;
}>) {
  const [key] = useState(() => crypto.randomUUID());
  const [feedback, setFeedback] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const mutation = useTokenRevocation({
    apiClient,
    userId,
    workspaceId,
    tokenId: token.id,
    key,
  });
  async function revoke() {
    if (inFlight.current) return;
    inFlight.current = true;
    setFeedback(undefined);
    try {
      await mutation.mutateAsync();
      onClose();
    } catch (cause) {
      const unknown = uncertainTokenOutcome(cause);
      setUncertain(unknown);
      setFeedback(
        unknown
          ? 'Revocation could not be confirmed. Retry the same request, or close and refresh the list.'
          : tokenCommandFeedback(cause, 'revoking this token').message,
      );
    } finally {
      inFlight.current = false;
    }
  }
  const changeConfirmationOpen = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <ConfirmDialog
      state={{
        open: true,
        onOpenChange: changeConfirmationOpen,
        locked: mutation.isPending,
      }}
      title={
        <span className="break-words [overflow-wrap:anywhere]">
          Revoke {token.name}?
        </span>
      }
      description="Scripts using this token will be refused. Already accepted requests and runs may finish. Signing out does not revoke a token."
      onSubmit={revoke}
      submitDisabled={mutation.isPending}
      actions={{
        cancel: !uncertain
          ? {
              kind: 'close',
              label: 'Cancel',
              variant: 'ghost',
              disabled: mutation.isPending,
            }
          : {
              kind: 'action',
              label: 'Close',
              variant: 'ghost',
              onClick: onClose,
            },
        confirm: {
          label: !uncertain ? 'Revoke token' : 'Try again',
          type: 'submit',
          variant: 'destructive',
          pending: mutation.isPending,
          pendingLabel: 'Revoking token…',
        },
      }}
    >
      <ConfirmationDetails
        error={feedback}
        tone={!uncertain ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
