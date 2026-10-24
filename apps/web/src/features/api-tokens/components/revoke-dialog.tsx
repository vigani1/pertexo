import { useRef, useState } from 'react';
import type { ApiTokenMetadata } from '@pertexo/contracts';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import type { ApiClient } from '@/lib/api/client';
import { useTokenRevocation } from '../data/api-tokens.mutations';
import { tokenCommandFeedback, uncertainTokenOutcome } from '../model/copy';

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
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="break-words [overflow-wrap:anywhere]">
          Revoke {token.name}?
        </span>
      }
      description="Scripts using this token will be refused. Already accepted requests and runs may finish. Signing out does not revoke a token."
      tone="destructive"
      confirmLabel="Revoke token"
      pendingLabel="Revoking token…"
      pending={mutation.isPending}
      locked={mutation.isPending}
      error={feedback}
      onConfirm={revoke}
      unconfirmed={
        uncertain ? { onRetry: revoke, onDismiss: onClose } : undefined
      }
    />
  );
}
