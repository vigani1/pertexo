import type { ApiTokenMetadata } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import type { ApiClient } from '@/lib/api/client';
import { useTokenRevocation } from '../data/api-tokens.mutations';

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
  const command = useTokenRevocation({
    apiClient,
    userId,
    workspaceId,
    tokenId: token.id,
    onRevoked: onClose,
  });
  const { uncertain, pending, error: feedback } = command;
  async function revoke() {
    if (uncertain) command.retry();
    else await command.send(null);
  }
  const changeConfirmationOpen = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <ConfirmDialog
      state={{
        open: true,
        onOpenChange: changeConfirmationOpen,
        locked: pending,
      }}
      title={
        <span className="break-words [overflow-wrap:anywhere]">
          Revoke {token.name}?
        </span>
      }
      description="Scripts using this token will be refused. Already accepted requests and runs may finish. Signing out does not revoke a token."
      onSubmit={revoke}
      submitDisabled={pending}
      actions={{
        cancel: !uncertain
          ? {
              kind: 'close',
              label: 'Cancel',
              variant: 'ghost',
              disabled: pending,
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
          pending: pending,
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
