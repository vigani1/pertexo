import { useId, useRef, useState } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts';
import { ProgressButton } from '@/components/ui/progress-button';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/error';
import {
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { connectionCommandError } from '../../model/connection-errors';
import {
  useRotateConnectionMutation,
  type ConnectionMutationScope,
  type RotateConnectionCommand,
} from '../../data/connections.mutations';
import { PROVIDERS } from '../../model/connection-providers';
import { isOAuth2Connection } from '../../model/oauth2-copy';
import { draftFromSettings } from '../../model/oauth2-draft';
import { CredentialFields } from '../credential/fields';
import { createHeaderRowId, useCredentialForm } from '../credential/use-form';

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
  const oauth2 = isOAuth2Connection(connection) ? connection.oauth2 : undefined;
  const credential = useCredentialForm(
    oauth2 === undefined ? connection.providerKey : 'oauth2',
    oauth2 === undefined ? undefined : draftFromSettings(oauth2.settings),
  );
  const [baseVersion, setBaseVersion] = useState(connection.secretVersionId);
  const { mutation, clearSensitiveState } = useRotateConnectionMutation(scope);
  const attempt = useRef<
    | Readonly<{
        signature: string;
        command: RotateConnectionCommand & CommandKey;
      }>
    | undefined
  >(undefined);

  function finish() {
    if (mutation.isPending) return;
    attempt.current = undefined;
    credential.clear();
    clearSensitiveState();
    onDone();
  }

  async function submit() {
    if (mutation.isPending) return;
    const value = credential.validate();
    if (value === undefined) return;
    const expectedVersion = replacingNewer
      ? connection.secretVersionId
      : baseVersion;
    if (replacingNewer) {
      setBaseVersion(expectedVersion);
      attempt.current = undefined;
    }
    const signature = JSON.stringify(value);
    const held = attempt.current;
    const command =
      held?.signature === signature && canResend(held.command)
        ? held.command
        : {
            connectionId: connection.id,
            expectedSecretVersionId: expectedVersion,
            credential: value,
            ...newCommandKey(),
          };
    attempt.current = { signature, command };
    try {
      await mutation.mutateAsync(command);
    } catch (error) {
      if (isApiError(error))
        credential.showServerIssues(error.problem?.errors ?? []);
      return;
    }
    notifications.success({
      title:
        oauth2 === undefined
          ? `Replaced the ${PROVIDERS[connection.providerKey].credential} for ${connection.name}`
          : `Saved the settings for ${connection.name}`,
    });
    finish();
  }

  const uncertain = mutation.isError && isUnconfirmedCommand(mutation.error);
  const replacingNewer =
    mutation.isError &&
    !uncertain &&
    isApiError(mutation.error) &&
    mutation.error.problem?.code === 'connection.conflict' &&
    connection.secretVersionId !== baseVersion;
  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {oauth2 === undefined ? (
          <>
            Steps keep using {connection.name}. The old{' '}
            {PROVIDERS[connection.providerKey].credential} stops being used as
            soon as this is saved.
          </>
        ) : (
          <>
            Steps keep using {connection.name}. Saving always asks for new
            consent, and its token stops being used until then. Type the client
            secret again so these addresses can have it.
          </>
        )}
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
          {replacingNewer
            ? 'A different credential was saved while you were editing. Use my credential replaces that latest version with what you entered.'
            : connectionCommandError(mutation.error, 'rotate', connection.name)}
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
        <ProgressButton
          type="submit"
          variant="primary"
          pending={mutation.isPending}
          pendingLabel="Replacing…"
        >
          {replaceLabel({
            uncertain,
            replacingNewer,
            oauth2: oauth2 !== undefined,
          })}
        </ProgressButton>
      </div>
    </form>
  );
}

function replaceLabel({
  uncertain,
  replacingNewer,
  oauth2,
}: Readonly<{
  uncertain: boolean;
  replacingNewer: boolean;
  oauth2: boolean;
}>): string {
  if (uncertain) return 'Try again';
  if (replacingNewer) return 'Use my credential';
  return oauth2 ? 'Save settings' : 'Replace credential';
}
