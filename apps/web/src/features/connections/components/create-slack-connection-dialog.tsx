import { useRef, useState, type SyntheticEvent } from 'react';
import { connectionCreateRequestSchema } from '@pertexo/contracts/schemas/connections';
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
import { connectionCreateErrorMessage } from '../connection-errors';
import {
  type SlackConnectionCommand,
  useCreateSlackConnectionMutation,
} from '../connections.mutations';

type CreateSlackConnectionDialogProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  triggerLabel?: string;
}>;

export function CreateSlackConnectionDialog({
  apiClient,
  userId,
  workspaceId,
  triggerLabel = 'Add connection',
}: CreateSlackConnectionDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [botToken, setBotToken] = useState('');
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<{ name?: string; botToken?: string }>
  >({});
  const validationAttempted = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const attempt = useRef<SlackConnectionCommand | undefined>(undefined);
  const { mutation, clearSensitiveState } = useCreateSlackConnectionMutation({
    apiClient,
    userId,
    workspaceId,
  });

  function resetForValues(nextName: string, nextBotToken: string) {
    if (mutation.isPending) return;
    setName(nextName);
    setBotToken(nextBotToken);
    clearSensitiveState();
    if (
      attempt.current?.name !== nextName.trim() ||
      attempt.current.botToken !== nextBotToken
    ) {
      attempt.current = undefined;
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    validationAttempted.current = true;
    const errors = slackFieldErrors(name, botToken);
    setFieldErrors(errors);
    if (errors.name !== undefined || errors.botToken !== undefined) {
      (errors.name !== undefined ? nameRef : tokenRef).current?.focus();
      return;
    }
    const parsed = connectionCreateRequestSchema.safeParse({
      providerKey: 'slack',
      name,
      credential: {
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken,
      },
    });
    if (!parsed.success || parsed.data.providerKey !== 'slack') {
      setFieldErrors({ botToken: 'Enter a valid Slack bot token.' });
      tokenRef.current?.focus();
      return;
    }
    const normalizedName = parsed.data.name;
    const normalizedToken = parsed.data.credential.botToken;
    const currentAttempt =
      attempt.current?.name === normalizedName &&
      attempt.current.botToken === normalizedToken
        ? attempt.current
        : {
            name: normalizedName,
            botToken: normalizedToken,
            idempotencyKey: crypto.randomUUID(),
          };
    attempt.current = currentAttempt;
    mutation.mutate(currentAttempt, {
      onSuccess: () => {
        attempt.current = undefined;
        setName('');
        setBotToken('');
        setOpen(false);
        clearSensitiveState();
      },
    });
  }

  function changeOpen(nextOpen: boolean) {
    if (mutation.isPending) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      attempt.current = undefined;
      setName('');
      setBotToken('');
      setFieldErrors({});
      validationAttempted.current = false;
      clearSensitiveState();
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="primary"
        onClick={() => {
          setOpen(true);
        }}
      >
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogTitle>Add a Slack connection</DialogTitle>
          <DialogDescription>
            Store a Slack bot token for workflow nodes that send Slack messages.
            The token is encrypted by the API and is never shown again.
          </DialogDescription>
          <form className="mt-6" onSubmit={submit}>
            <FieldGroup>
              <Field data-invalid={fieldErrors.name !== undefined}>
                <FieldLabel htmlFor="slack-connection-name">
                  Connection name
                </FieldLabel>
                <Input
                  id="slack-connection-name"
                  ref={nameRef}
                  name="name"
                  autoComplete="off"
                  autoFocus
                  maxLength={128}
                  disabled={mutation.isPending}
                  value={name}
                  aria-invalid={fieldErrors.name !== undefined}
                  aria-describedby={
                    fieldErrors.name !== undefined
                      ? 'slack-name-help slack-name-error'
                      : 'slack-name-help'
                  }
                  onChange={(event) => {
                    const nextName = event.currentTarget.value;
                    resetForValues(nextName, botToken);
                    if (validationAttempted.current)
                      setFieldErrors(slackFieldErrors(nextName, botToken));
                    else if (fieldErrors.name !== undefined)
                      setFieldErrors((current) => {
                        const error = slackNameError(nextName);
                        return error === undefined
                          ? current.botToken === undefined
                            ? {}
                            : { botToken: current.botToken }
                          : { ...current, name: error };
                      });
                  }}
                  onBlur={() => {
                    setFieldErrors((current) => {
                      const error = slackNameError(name);
                      return error === undefined
                        ? current.botToken === undefined
                          ? {}
                          : { botToken: current.botToken }
                        : { ...current, name: error };
                    });
                  }}
                />
                <FieldDescription id="slack-name-help">
                  Use a name that identifies the Slack workspace or purpose.
                </FieldDescription>
                {fieldErrors.name === undefined ? null : (
                  <FieldError id="slack-name-error">
                    {fieldErrors.name}
                  </FieldError>
                )}
              </Field>
              <Field data-invalid={fieldErrors.botToken !== undefined}>
                <FieldLabel htmlFor="slack-bot-token">
                  Slack bot token
                </FieldLabel>
                <Input
                  id="slack-bot-token"
                  ref={tokenRef}
                  name="botToken"
                  type="password"
                  autoComplete="new-password"
                  maxLength={512}
                  disabled={mutation.isPending}
                  value={botToken}
                  aria-invalid={fieldErrors.botToken !== undefined}
                  aria-describedby={
                    fieldErrors.botToken !== undefined
                      ? 'slack-token-help slack-token-error'
                      : 'slack-token-help'
                  }
                  onChange={(event) => {
                    const nextToken = event.currentTarget.value;
                    resetForValues(name, nextToken);
                    if (validationAttempted.current)
                      setFieldErrors(slackFieldErrors(name, nextToken));
                    else if (fieldErrors.botToken !== undefined)
                      setFieldErrors((current) => {
                        const error = slackTokenError(nextToken);
                        return error === undefined
                          ? current.name === undefined
                            ? {}
                            : { name: current.name }
                          : { ...current, botToken: error };
                      });
                  }}
                  onBlur={() => {
                    setFieldErrors((current) => {
                      const error = slackTokenError(botToken);
                      return error === undefined
                        ? current.name === undefined
                          ? {}
                          : { name: current.name }
                        : { ...current, botToken: error };
                    });
                  }}
                />
                <FieldDescription id="slack-token-help">
                  Expected format: xoxb-… The token stays transient while this
                  dialog remains open.
                </FieldDescription>
                {fieldErrors.botToken === undefined ? null : (
                  <FieldError id="slack-token-error">
                    {fieldErrors.botToken}
                  </FieldError>
                )}
              </Field>
            </FieldGroup>
            {mutation.isError ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {connectionCreateErrorMessage(mutation.error)}
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
                variant="primary"
                disabled={mutation.isPending}
              >
                {mutation.isPending
                  ? 'Adding…'
                  : mutation.isError
                    ? 'Retry safely'
                    : 'Add connection'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function slackFieldErrors(name: string, botToken: string) {
  const nameError = slackNameError(name);
  const botTokenError = slackTokenError(botToken);
  return {
    ...(nameError === undefined ? {} : { name: nameError }),
    ...(botTokenError === undefined ? {} : { botToken: botTokenError }),
  } as const;
}

function slackNameError(name: string): string | undefined {
  return name.trim() === '' ? 'Enter a connection name.' : undefined;
}

function slackTokenError(botToken: string): string | undefined {
  return /^xoxb-[A-Za-z0-9-]{5,}$/u.test(botToken.trim())
    ? undefined
    : 'Enter a Slack bot token beginning with xoxb-.';
}
