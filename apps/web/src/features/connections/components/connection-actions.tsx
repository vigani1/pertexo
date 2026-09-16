import { useId, useRef, useState, type SyntheticEvent } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import {
  connectionRevokeErrorMessage,
  connectionRotateErrorMessage,
  connectionTestErrorMessage,
} from '../connection-errors';
import {
  type RotateSlackConnectionCommand,
  type TestConnectionCommand,
  useRevokeConnectionMutation,
  useRotateSlackConnectionMutation,
  useTestSlackConnectionMutation,
} from '../connections.mutations';

type ConnectionActionsProps = Readonly<{
  apiClient: ApiClient;
  connection: ConnectionResponse;
  userId: string;
  workspaceId: string;
  canTest: boolean;
  canManage: boolean;
}>;

export function ConnectionActions(props: ConnectionActionsProps) {
  const scope = {
    apiClient: props.apiClient,
    userId: props.userId,
    workspaceId: props.workspaceId,
  };
  const test = useTestSlackConnectionMutation(scope);
  const rotation = useRotateSlackConnectionMutation(scope);
  const rotate = rotation.mutation;
  const revoke = useRevokeConnectionMutation(scope);
  const testAttempt = useRef<TestConnectionCommand | undefined>(undefined);
  const busy = test.isPending || rotate.isPending || revoke.isPending;

  function runTest() {
    if (busy) return;
    const command =
      test.isError && testAttempt.current !== undefined
        ? testAttempt.current
        : {
            connectionId: props.connection.id,
            idempotencyKey: crypto.randomUUID(),
          };
    testAttempt.current = command;
    test.mutate(command, {
      onSuccess: () => {
        testAttempt.current = undefined;
      },
    });
  }

  return (
    <div className="flex min-w-max items-center justify-end gap-2">
      {props.canTest && props.connection.providerKey === 'slack' ? (
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || props.connection.status === 'revoked'}
            onClick={runTest}
          >
            {test.isPending
              ? 'Testing…'
              : test.isError
                ? 'Retry test'
                : test.isSuccess
                  ? 'Test again'
                  : 'Test'}
          </Button>
          {test.isSuccess ? (
            <p
              role="status"
              className={
                test.data.outcome.ok
                  ? 'max-w-52 text-right text-xs text-primary'
                  : 'max-w-52 text-right text-xs text-destructive'
              }
            >
              {test.data.outcome.ok
                ? 'Connection test passed.'
                : `Connection test failed: ${test.data.outcome.errorCode}.`}
            </p>
          ) : test.isError ? (
            <p
              role="alert"
              className="max-w-52 text-right text-xs text-destructive"
            >
              {connectionTestErrorMessage(test.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {props.canManage && props.connection.authType === 'slack_bot_token' ? (
        <RotateSlackConnectionDialog
          connection={props.connection}
          mutation={rotate}
          clearSensitiveState={rotation.clearSensitiveState}
          disabled={busy}
        />
      ) : null}
      {props.canManage ? (
        <RevokeConnectionDialog
          connection={props.connection}
          mutation={revoke}
          disabled={busy}
        />
      ) : null}
    </div>
  );
}

type RotateMutation = ReturnType<
  typeof useRotateSlackConnectionMutation
>['mutation'];

function RotateSlackConnectionDialog({
  connection,
  mutation,
  clearSensitiveState,
  disabled,
}: Readonly<{
  connection: ConnectionResponse;
  mutation: RotateMutation;
  clearSensitiveState: () => void;
  disabled: boolean;
}>) {
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const tokenRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const validationAttempted = useRef(false);
  const attempt = useRef<RotateSlackConnectionCommand | undefined>(undefined);

  function reset() {
    attempt.current = undefined;
    setBotToken('');
    setValidationError(undefined);
    validationAttempted.current = false;
    clearSensitiveState();
  }

  function changeOpen(nextOpen: boolean) {
    if (mutation.isPending) return;
    setOpen(nextOpen);
    if (!nextOpen) reset();
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedToken = botToken.trim();
    validationAttempted.current = true;
    const tokenError = slackBotTokenError(normalizedToken);
    if (tokenError !== undefined) {
      setValidationError(tokenError);
      tokenRef.current?.focus();
      return;
    }
    const command =
      attempt.current?.botToken === normalizedToken
        ? attempt.current
        : {
            connectionId: connection.id,
            expectedSecretVersionId: connection.secretVersionId,
            botToken: normalizedToken,
            idempotencyKey: crypto.randomUUID(),
          };
    attempt.current = command;
    setValidationError(undefined);
    mutation.mutate(command, {
      onSuccess: () => {
        setOpen(false);
        reset();
      },
    });
  }

  const invalid = validationError !== undefined;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled || connection.status === 'revoked'}
        onClick={() => {
          setOpen(true);
        }}
      >
        Rotate token
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogTitle>Rotate {connection.name} token</DialogTitle>
          <DialogDescription>
            Replace the stored Slack bot token. Existing workflow references
            keep using this connection; the old token stops being used after the
            command succeeds.
          </DialogDescription>
          <form className="mt-6" onSubmit={submit}>
            <FieldGroup>
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={fieldId}>New Slack bot token</FieldLabel>
                <Input
                  id={fieldId}
                  ref={tokenRef}
                  name="botToken"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  maxLength={512}
                  disabled={mutation.isPending}
                  value={botToken}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? `${helpId} ${errorId}` : helpId}
                  onChange={(event) => {
                    const nextToken = event.currentTarget.value;
                    setBotToken(nextToken);
                    if (
                      validationAttempted.current ||
                      validationError !== undefined
                    )
                      setValidationError(slackBotTokenError(nextToken));
                    clearSensitiveState();
                    if (attempt.current?.botToken !== nextToken.trim())
                      attempt.current = undefined;
                  }}
                  onBlur={() => {
                    setValidationError(slackBotTokenError(botToken));
                  }}
                />
                <FieldDescription id={helpId}>
                  The new token stays only in this dialog until you close it or
                  rotation succeeds.
                </FieldDescription>
                {validationError ? (
                  <FieldError id={errorId}>{validationError}</FieldError>
                ) : null}
              </Field>
            </FieldGroup>
            {mutation.isError ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {connectionRotateErrorMessage(mutation.error)}
              </p>
            ) : null}
            <div className="mt-7 flex justify-end gap-2">
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={mutation.isPending}
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button
                type="submit"
                variant="solid"
                disabled={mutation.isPending}
              >
                {mutation.isPending
                  ? 'Rotating…'
                  : mutation.isError
                    ? 'Retry safely'
                    : 'Rotate token'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function slackBotTokenError(botToken: string): string | undefined {
  return /^xoxb-[A-Za-z0-9-]{5,}$/u.test(botToken.trim())
    ? undefined
    : 'Enter a Slack bot token beginning with xoxb-.';
}

type RevokeMutation = ReturnType<typeof useRevokeConnectionMutation>;

function RevokeConnectionDialog({
  connection,
  mutation,
  disabled,
}: Readonly<{
  connection: ConnectionResponse;
  mutation: RevokeMutation;
  disabled: boolean;
}>) {
  const [open, setOpen] = useState(false);

  function changeOpen(nextOpen: boolean) {
    if (mutation.isPending) return;
    setOpen(nextOpen);
    if (!nextOpen) mutation.reset();
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={disabled || connection.status === 'revoked'}
        onClick={() => {
          setOpen(true);
        }}
      >
        Revoke
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogTitle>Revoke {connection.name}?</DialogTitle>
          <DialogDescription>
            Pertexo will stop using this connection for new provider calls.
            Historical workflow and run references are not erased.
          </DialogDescription>
          {mutation.isError ? (
            <p role="alert" className="mt-5 text-sm text-destructive">
              {connectionRevokeErrorMessage(mutation.error)}
            </p>
          ) : null}
          <div className="mt-7 flex justify-end gap-2">
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isPending}
                />
              }
            >
              Keep connection
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => {
                mutation.mutate(connection.id, {
                  onSuccess: () => {
                    setOpen(false);
                    mutation.reset();
                  },
                });
              }}
            >
              {mutation.isPending ? 'Revoking…' : 'Revoke connection'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
