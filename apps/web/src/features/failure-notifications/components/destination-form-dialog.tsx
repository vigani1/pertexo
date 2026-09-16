import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import {
  failureNotificationDestinationConfigSchema,
  type FailureNotificationDestinationConfig,
  type FailureNotificationDestinationResponse,
} from '@pertexo/contracts/schemas/failure-notifications';
import { useRef, useState, type SyntheticEvent } from 'react';
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
import { isApiError } from '@/lib/api/api-error';
import { destinationCommandErrorMessage } from '../failure-notification-errors';
import {
  useAppendFailureNotificationDestinationVersionMutation,
  useCreateFailureNotificationDestinationMutation,
} from '../failure-notifications.mutations';

type CreateDestinationCommand = Readonly<{
  signature: string;
  config: FailureNotificationDestinationConfig;
  idempotencyKey: string;
}>;

type EditDestinationSnapshot = Readonly<{
  destinationId: string;
  expectedVersion: number;
  kind: 'slack' | 'email';
  connectionId: string;
  target: string;
}>;

type EditDestinationCommand = Readonly<{
  signature: string;
  destinationId: string;
  expectedVersion: number;
  config: FailureNotificationDestinationConfig;
  idempotencyKey: string;
}>;

export function DestinationFormDialog({
  apiClient,
  userId,
  workspaceId,
  connections,
  destination,
  listRefreshFailed = false,
  listRefreshPending = false,
  onRetryListRefresh,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  connections: readonly ConnectionResponse[];
  destination?: FailureNotificationDestinationResponse;
  listRefreshFailed?: boolean;
  listRefreshPending?: boolean;
  onRetryListRefresh?: () => void;
}>) {
  const editing = destination !== undefined;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'slack' | 'email'>('slack');
  const [connectionId, setConnectionId] = useState('');
  const [target, setTarget] = useState('');
  const [editingSnapshot, setEditingSnapshot] =
    useState<EditDestinationSnapshot>();
  const [validationErrors, setValidationErrors] = useState<
    Readonly<Partial<Record<'connection' | 'target', string>>>
  >({});
  const [validationAttempted, setValidationAttempted] = useState(false);
  const connectionRef = useRef<HTMLSelectElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const createAttempt = useRef<CreateDestinationCommand | undefined>(undefined);
  const editAttempt = useRef<EditDestinationCommand | undefined>(undefined);
  const scope = { apiClient, userId, workspaceId };
  const create = useCreateFailureNotificationDestinationMutation(scope);
  const append = useAppendFailureNotificationDestinationVersionMutation(scope);
  const mutation = editing ? append : create;
  const compatibleConnections = connections.filter(
    (connection) =>
      connection.providerKey === kind && connection.status === 'active',
  );

  function reset() {
    setKind('slack');
    setConnectionId('');
    setTarget('');
    setEditingSnapshot(undefined);
    setValidationErrors({});
    setValidationAttempted(false);
    createAttempt.current = undefined;
    editAttempt.current = undefined;
    create.reset();
    append.reset();
  }

  function openDialog() {
    if (destination === undefined) {
      reset();
      setOpen(true);
      return;
    }
    const snapshot: EditDestinationSnapshot = {
      destinationId: destination.id,
      expectedVersion: destination.currentVersion,
      kind: destination.kind,
      connectionId: destination.config.connectionId,
      target:
        destination.config.kind === 'email'
          ? destination.config.toEmail
          : destination.config.channelId,
    };
    setEditingSnapshot(snapshot);
    setKind(snapshot.kind);
    setConnectionId(snapshot.connectionId);
    setTarget(snapshot.target);
    setValidationErrors({});
    setValidationAttempted(false);
    createAttempt.current = undefined;
    editAttempt.current = undefined;
    create.reset();
    append.reset();
    setOpen(true);
  }

  function changeOpen(nextOpen: boolean) {
    if (mutation.isPending) return;
    setOpen(nextOpen);
    if (!nextOpen) reset();
  }

  function updateValues(next: {
    kind?: 'slack' | 'email';
    connectionId?: string;
    target?: string;
  }) {
    if (mutation.isPending) return;
    if (next.kind !== undefined) {
      setKind(next.kind);
      setConnectionId('');
      setTarget('');
    }
    if (next.connectionId !== undefined) setConnectionId(next.connectionId);
    if (next.target !== undefined) setTarget(next.target);
    if (validationAttempted) {
      const nextKind = next.kind ?? kind;
      const nextConnectionId =
        next.kind === undefined ? (next.connectionId ?? connectionId) : '';
      const nextTarget = next.kind === undefined ? (next.target ?? target) : '';
      setValidationErrors(
        validateDestinationFields(
          nextKind,
          nextConnectionId,
          nextTarget,
          connections,
        ),
      );
    }
    create.reset();
    append.reset();
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationAttempted(true);
    const fieldErrors = validateDestinationFields(
      kind,
      connectionId,
      target,
      connections,
    );
    setValidationErrors(fieldErrors);
    if (fieldErrors.connection !== undefined) {
      connectionRef.current?.focus();
      return;
    }
    if (fieldErrors.target !== undefined) {
      targetRef.current?.focus();
      return;
    }
    const parsed = failureNotificationDestinationConfigSchema.safeParse(
      kind === 'slack'
        ? { kind, connectionId, channelId: target.trim() }
        : { kind, connectionId, toEmail: target.trim() },
    );
    if (!parsed.success) {
      setValidationErrors({
        target:
          kind === 'slack'
            ? 'Enter a valid Slack channel ID.'
            : 'Enter a valid recipient email address.',
      });
      targetRef.current?.focus();
      return;
    }
    const signature = JSON.stringify(parsed.data);
    if (destination === undefined) {
      const command =
        createAttempt.current?.signature === signature
          ? createAttempt.current
          : {
              signature,
              config: parsed.data,
              idempotencyKey: crypto.randomUUID(),
            };
      createAttempt.current = command;
      create.mutate(command, {
        onSuccess: () => {
          changeOpen(false);
        },
        onError: handleMutationError,
      });
      return;
    }
    if (editingSnapshot === undefined) return;
    const command =
      editAttempt.current?.signature === signature
        ? editAttempt.current
        : {
            signature,
            destinationId: editingSnapshot.destinationId,
            expectedVersion: editingSnapshot.expectedVersion,
            config: parsed.data,
            idempotencyKey: crypto.randomUUID(),
          };
    editAttempt.current = command;
    append.mutate(command, {
      onSuccess: () => {
        changeOpen(false);
      },
      onError: handleMutationError,
    });
  }

  function handleMutationError(cause: unknown) {
    const mapped = destinationServerFieldErrors(cause, kind);
    if (Object.keys(mapped).length === 0) return;
    setValidationErrors(mapped);
    queueMicrotask(() => {
      if (mapped.connection !== undefined) connectionRef.current?.focus();
      else if (mapped.target !== undefined) targetRef.current?.focus();
    });
  }

  const serverFieldErrors = destinationServerFieldErrors(mutation.error, kind);
  const commandError =
    mutation.isError && Object.keys(serverFieldErrors).length === 0
      ? destinationCommandErrorMessage(
          mutation.error,
          editing ? 'update this destination' : 'create this destination',
        )
      : undefined;
  const idPrefix = `${destination?.id ?? 'new'}-destination`;

  return (
    <>
      <Button
        type="button"
        variant={editing ? 'outline' : 'solid'}
        size={editing ? 'sm' : 'default'}
        onClick={openDialog}
      >
        {editing ? 'Edit' : 'Add destination'}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogTitle>
            {editing
              ? 'Edit notification destination'
              : 'Add notification destination'}
          </DialogTitle>
          <DialogDescription>
            Destinations reference an existing connection. Credentials remain in
            the connection vault and are never copied into this configuration.
          </DialogDescription>
          {listRefreshFailed && onRetryListRefresh !== undefined ? (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
            >
              <p className="text-sm text-destructive">
                The destination list may be stale because its latest refresh
                failed. This edit is preserved.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={listRefreshPending}
                onClick={onRetryListRefresh}
              >
                {listRefreshPending ? 'Retrying…' : 'Retry refresh'}
              </Button>
            </div>
          ) : null}
          <form className="mt-6" onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-kind`}>
                  Delivery type
                </FieldLabel>
                <select
                  id={`${idPrefix}-kind`}
                  name="destinationKind"
                  autoComplete="off"
                  className="recessed-control h-10 rounded-lg border px-3 text-base md:text-sm"
                  value={kind}
                  disabled={editing || mutation.isPending}
                  onChange={(event) => {
                    updateValues({
                      kind:
                        event.currentTarget.value === 'email'
                          ? 'email'
                          : 'slack',
                    });
                  }}
                >
                  <option value="slack">Slack channel</option>
                  <option value="email">Email recipient</option>
                </select>
                {editing ? (
                  <FieldDescription>
                    Create another destination to change the delivery type.
                  </FieldDescription>
                ) : null}
              </Field>
              <Field data-invalid={validationErrors.connection !== undefined}>
                <FieldLabel htmlFor={`${idPrefix}-connection`}>
                  {kind === 'slack' ? 'Slack connection' : 'Email connection'}
                </FieldLabel>
                <select
                  ref={connectionRef}
                  id={`${idPrefix}-connection`}
                  name="destinationConnection"
                  autoComplete="off"
                  className="recessed-control h-10 rounded-lg border px-3 text-base md:text-sm"
                  value={connectionId}
                  disabled={mutation.isPending}
                  aria-invalid={validationErrors.connection !== undefined}
                  aria-describedby={
                    validationErrors.connection === undefined
                      ? undefined
                      : `${idPrefix}-connection-error`
                  }
                  onBlur={() => {
                    const nextErrors = validateDestinationFields(
                      kind,
                      connectionId,
                      target,
                      connections,
                    );
                    setValidationErrors((current) =>
                      nextErrors.connection === undefined
                        ? withoutDestinationError(current, 'connection')
                        : {
                            ...current,
                            connection: nextErrors.connection,
                          },
                    );
                  }}
                  onChange={(event) => {
                    updateValues({ connectionId: event.currentTarget.value });
                  }}
                >
                  <option value="">Choose a connection</option>
                  {compatibleConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
                {compatibleConnections.length === 0 ? (
                  <FieldDescription>
                    Add an active {kind} connection before configuring this
                    destination.
                  </FieldDescription>
                ) : null}
                {validationErrors.connection === undefined ? null : (
                  <FieldError id={`${idPrefix}-connection-error`}>
                    {validationErrors.connection}
                  </FieldError>
                )}
              </Field>
              <Field data-invalid={validationErrors.target !== undefined}>
                <FieldLabel htmlFor={`${idPrefix}-target`}>
                  {kind === 'slack' ? 'Channel ID' : 'Recipient email'}
                </FieldLabel>
                <Input
                  ref={targetRef}
                  id={`${idPrefix}-target`}
                  name="target"
                  autoComplete={kind === 'email' ? 'email' : 'off'}
                  placeholder={
                    kind === 'slack' ? 'C0123456789' : 'alerts@example.com'
                  }
                  value={target}
                  disabled={mutation.isPending}
                  aria-invalid={validationErrors.target !== undefined}
                  aria-describedby={
                    validationErrors.target === undefined
                      ? undefined
                      : `${idPrefix}-target-error`
                  }
                  onBlur={() => {
                    const nextErrors = validateDestinationFields(
                      kind,
                      connectionId,
                      target,
                      connections,
                    );
                    setValidationErrors((current) =>
                      nextErrors.target === undefined
                        ? withoutDestinationError(current, 'target')
                        : { ...current, target: nextErrors.target },
                    );
                  }}
                  onChange={(event) => {
                    updateValues({ target: event.currentTarget.value });
                  }}
                />
                {validationErrors.target === undefined ? null : (
                  <FieldError id={`${idPrefix}-target-error`}>
                    {validationErrors.target}
                  </FieldError>
                )}
              </Field>
              {commandError === undefined ? null : (
                <FieldError id={`${idPrefix}-command-error`}>
                  {commandError}
                </FieldError>
              )}
            </FieldGroup>
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
                  ? 'Saving…'
                  : mutation.isError
                    ? 'Retry safely'
                    : editing
                      ? 'Save new version'
                      : 'Add destination'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function destinationServerFieldErrors(
  error: unknown,
  kind: 'slack' | 'email',
): Readonly<Partial<Record<'connection' | 'target', string>>> {
  if (!isApiError(error)) return {};
  const errors: Partial<Record<'connection' | 'target', string>> = {};
  for (const issue of error.problem?.errors ?? []) {
    if (/(?:^|\.)connectionId$/u.test(issue.path))
      errors.connection = issue.message;
    else if (
      new RegExp(
        `(?:^|\\.)${kind === 'slack' ? 'channelId' : 'toEmail'}$`,
        'u',
      ).test(issue.path)
    )
      errors.target = issue.message;
  }
  return errors;
}

function validateDestinationFields(
  kind: 'slack' | 'email',
  connectionId: string,
  target: string,
  connections: readonly ConnectionResponse[],
): Readonly<Partial<Record<'connection' | 'target', string>>> {
  const errors: Partial<Record<'connection' | 'target', string>> = {};
  const connection = connections.find(
    (candidate) =>
      candidate.id === connectionId &&
      candidate.providerKey === kind &&
      candidate.status === 'active',
  );
  if (connection === undefined)
    errors.connection = `Choose an active ${kind} connection.`;
  const normalizedTarget = target.trim();
  if (normalizedTarget === '')
    errors.target =
      kind === 'slack'
        ? 'Enter a Slack channel ID.'
        : 'Enter a recipient email address.';
  else {
    const parsed = failureNotificationDestinationConfigSchema.safeParse(
      kind === 'slack'
        ? { kind, connectionId, channelId: normalizedTarget }
        : { kind, connectionId, toEmail: normalizedTarget },
    );
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        if (issue.path.includes('connectionId'))
          errors.connection = `Choose an active ${kind} connection.`;
        if (issue.path.includes(kind === 'slack' ? 'channelId' : 'toEmail'))
          errors.target =
            kind === 'slack'
              ? 'Enter a valid Slack channel ID.'
              : 'Enter a valid recipient email address.';
      }
  }
  return errors;
}

function withoutDestinationError(
  current: Readonly<Partial<Record<'connection' | 'target', string>>>,
  field: 'connection' | 'target',
) {
  return Object.fromEntries(
    Object.entries(current).filter(([name]) => name !== field),
  );
}
