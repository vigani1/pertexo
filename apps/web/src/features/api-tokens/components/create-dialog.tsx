import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ApiTokenCreateRequest, ApiTokenScope } from '@pertexo/contracts';
import {
  allowlistedReturnPath,
  returnToSearch,
} from '@/features/auth/auth-routing.public';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import { useApiTokenIssue } from '../data/api-tokens.mutations';
import {
  tokenCommandFeedback,
  uncertainTokenOutcome,
} from '../model/token-copy';
import { CreateTokenForm } from '../forms/create-token';
import { TokenSecretReceipt } from './secret-receipt';
import { FRESH_SIGN_IN_WINDOW_MILLIS } from '@pertexo/workflow-model';
import { formatTimeSpan } from '@/lib/format/time';

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
  const request = useApiTokenIssue(apiClient, workspaceId);
  async function create(body: ApiTokenCreateRequest) {
    if (view.kind !== 'form') return;
    setView({ kind: 'form' });
    const outcome = await request.run(body);
    if (outcome.kind === 'superseded') return;
    if (outcome.kind === 'done') {
      const result = outcome.value;
      setView(
        result.replayed
          ? { kind: 'unconfirmed' }
          : { kind: 'secret', secret: result.secret, name: result.token.name },
      );
      onRefresh();
    } else if (uncertainTokenOutcome(outcome.cause)) {
      setView({ kind: 'unconfirmed' });
      onRefresh();
    } else
      setView({
        kind: 'form',
        feedback: tokenCommandFeedback(outcome.cause, 'creating this token'),
      });
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
        ) : null}
        {view.kind === 'unconfirmed' ? (
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
        ) : null}
        {view.kind === 'form' ? (
          <>
            <DialogTitle>Create API token</DialogTitle>
            <DialogDescription>
              {`For your scripts in this workspace. Creation needs a sign-in from the last ${formatTimeSpan(FRESH_SIGN_IN_WINDOW_MILLIS / 1_000)}.`}
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
              onClose={onClose}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
