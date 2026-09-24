import { useId, useRef } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/api-error';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';
import { connectionCommandError } from '../../connection-errors';
import {
  useRotateConnectionMutation,
  type ConnectionMutationScope,
  type RotateConnectionCommand,
} from '../../connections.mutations';
import { PROVIDERS } from '../../model/connection-providers';
import { CredentialFields } from '../credential/credential-fields';
import {
  createHeaderRowId,
  useCredentialForm,
} from '../credential/use-credential-form';

/**
 * Replaces a connection's stored credential. The command names the secret
 * version it replaces, so a concurrent replacement is refused, not overwritten.
 */
export function ReplaceCredentialForm({
  scope,
  connection,
  onDone,
}: Readonly<{
  scope: ConnectionMutationScope;
  connection: ConnectionResponse;
  onDone: () => void;
}>) {
  const id = useId();
  const notifications = useNotifications();
  const credential = useCredentialForm(connection.providerKey);
  const { mutation, clearSensitiveState } = useRotateConnectionMutation(scope);
  const attempt = useRef<
    | Readonly<{ signature: string; command: RotateConnectionCommand }>
    | undefined
  >(undefined);

  function finish() {
    if (mutation.isPending) return;
    attempt.current = undefined;
    credential.clear();
    clearSensitiveState();
    onDone();
  }

  function submit() {
    if (mutation.isPending) return;
    const value = credential.validate();
    if (value === undefined) return;
    const signature = JSON.stringify(value);
    const command =
      attempt.current?.signature === signature
        ? attempt.current.command
        : {
            connectionId: connection.id,
            expectedSecretVersionId: connection.secretVersionId,
            credential: value,
            idempotencyKey: crypto.randomUUID(),
          };
    attempt.current = { signature, command };
    mutation.mutate(command, {
      onSuccess: () => {
        notifications.success({
          title: `Replaced the ${PROVIDERS[connection.providerKey].credential} for ${connection.name}`,
        });
        finish();
      },
      onError: (error) => {
        if (isApiError(error))
          credential.showServerIssues(error.problem?.errors ?? []);
      },
    });
  }

  const uncertain = mutation.isError && isUncertainOutcome(mutation.error);
  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Steps keep using {connection.name}. The old{' '}
        {PROVIDERS[connection.providerKey].credential} stops being used as soon
        as this is saved.
      </p>
      <CredentialFields
        draft={credential.draft}
        idPrefix={id}
        disabled={mutation.isPending}
        validation={credential.validation}
        createId={createHeaderRowId}
        onChange={(next) => {
          credential.setDraft(next);
          if (mutation.isError) clearSensitiveState();
        }}
      />
      {mutation.isError ? (
        <Notice role="alert" tone={uncertain ? 'warning' : 'destructive'}>
          {connectionCommandError(mutation.error, 'rotate', connection.name)}
        </Notice>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={finish}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? <LoadingOrb data-icon="inline-start" /> : null}
          {mutation.isPending
            ? 'Replacing…'
            : uncertain
              ? 'Try again'
              : 'Replace credential'}
        </Button>
      </div>
    </form>
  );
}
