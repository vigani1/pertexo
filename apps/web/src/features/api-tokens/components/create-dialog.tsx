import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ApiTokenCreateRequest, ApiTokenScope } from '@pertexo/contracts';
import {
  allowlistedReturnPath,
  returnToSearch,
} from '@/features/auth/return-path.public';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { createApiToken } from '../data/api-tokens.api';
import { tokenCommandFeedback, uncertainTokenOutcome } from '../model/copy';
import { CreateTokenForm } from '../forms/create';
import { TokenSecretReceipt } from './secret-receipt';

type CreationView =
  | { kind: 'form'; feedback?: ReturnType<typeof tokenCommandFeedback> }
  | { kind: 'unconfirmed' }
  | { kind: 'secret'; secret: string; name: string };

export function CreateTokenDialog({
  apiClient,
  workspaceId,
  availableScopes,
  onRefresh,
  onClose,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  availableScopes: readonly ApiTokenScope[];
  onRefresh: () => void;
  onClose: () => void;
}>) {
  const [view, setView] = useState<CreationView>({ kind: 'form' });
  const request = useLatestRequest();
  const inFlight = useRef(false);
  async function create(body: ApiTokenCreateRequest) {
    if (inFlight.current || view.kind !== 'form') return;
    inFlight.current = true;
    const attempt = request.begin();
    setView({ kind: 'form' });
    try {
      const result = await createApiToken({
        apiClient,
        workspaceId,
        body,
        idempotencyKey: crypto.randomUUID(),
        signal: attempt.signal,
      });
      if (!attempt.isCurrent()) return;
      setView(
        result.replayed
          ? { kind: 'unconfirmed' }
          : { kind: 'secret', secret: result.secret, name: result.token.name },
      );
      onRefresh();
    } catch (cause) {
      if (!attempt.isCurrent()) return;
      if (uncertainTokenOutcome(cause)) {
        setView({ kind: 'unconfirmed' });
        onRefresh();
      } else
        setView({
          kind: 'form',
          feedback: tokenCommandFeedback(cause, 'creating this token'),
        });
    } finally {
      inFlight.current = false;
      attempt.finish();
    }
  }
  return (
    <Dialog
      open
      disablePointerDismissal={request.pending || view.kind === 'secret'}
      onOpenChange={(open) => {
        if (!open && !request.pending && view.kind !== 'secret') onClose();
      }}
    >
      <DialogContent>
        {view.kind === 'secret' ? (
          <TokenSecretReceipt
            secret={view.secret}
            name={view.name}
            onDone={onClose}
          />
        ) : view.kind === 'unconfirmed' ? (
          <>
            <DialogTitle>Check your tokens</DialogTitle>
            <DialogDescription>
              Creation could not be confirmed, or its one-time secret is no
              longer available. The token may exist, but Pertexo cannot show its
              secret again.
            </DialogDescription>
            <Notice tone="warning" className="mt-5">
              Close this dialog and refresh the list. Revoke the token you
              cannot use before creating a replacement.
            </Notice>
            <Button
              type="button"
              className="mt-5"
              onClick={() => {
                onRefresh();
                onClose();
              }}
            >
              Close and check tokens
            </Button>
          </>
        ) : (
          <>
            <DialogTitle>Create API token</DialogTitle>
            <DialogDescription>
              For your scripts in this workspace. Creation needs a sign-in from
              the last five minutes.
            </DialogDescription>
            {view.feedback === undefined ? null : (
              <Notice
                tone="destructive"
                className="mt-4"
                action={
                  view.feedback.freshSignIn ? (
                    <Link
                      to="/logout"
                      search={returnToSearch(
                        allowlistedReturnPath(
                          `/w/${workspaceId}/settings/api-tokens`,
                        ),
                      )}
                      className="inline-link"
                    >
                      Sign in again
                    </Link>
                  ) : undefined
                }
              >
                {view.feedback.message}
              </Notice>
            )}
            <CreateTokenForm
              availableScopes={availableScopes}
              pending={request.pending}
              onCreate={create}
            />
            <Button
              type="button"
              variant="ghost"
              className="mt-3"
              disabled={request.pending}
              onClick={onClose}
            >
              Cancel
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
