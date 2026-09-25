import { usableConnections } from '../model/destination-copy';
import { useId, useRef, useState } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import { ProgressButton } from '@/components/ui/progress-button';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FieldGroup } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  SheetBody,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/api-error';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';
import {
  destinationCommandError,
  isDestinationConflict,
} from '../failure-notification-errors';
import {
  useAppendFailureNotificationDestinationVersionMutation,
  useCreateFailureNotificationDestinationMutation,
  type DestinationMutationScope,
} from '../failure-notifications.mutations';
import {
  channelKey,
  describeChannel,
  type ChannelNames,
} from '../model/channel-names';
import {
  describeDestination,
  destinationErrors,
  destinationServerErrors,
  toDestinationConfig,
  type DestinationField,
} from '../model/destination-copy';
import {
  DestinationFields,
  type DestinationValues,
} from './destination-fields';

export type ListRefresh = Readonly<{
  failed: boolean;
  pending: boolean;
  /** When the list on screen was fetched, in epoch milliseconds. */
  updatedAt: number;
  /** Refetches the list and resolves with the latest destinations. */
  reload: () => Promise<readonly FailureNotificationDestinationResponse[]>;
}>;

/** The version and identifier, for support rather than for deciding. */
function DestinationDetails({
  destinationId,
  version,
}: Readonly<{ destinationId: string; version: number }>) {
  return (
    <details className="text-sm text-subtle-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">
        Details
      </summary>
      <p className="mt-2 flex items-center gap-2 font-mono text-xs">
        Version {version} · saving creates version {version + 1}
      </p>
      <CopyButton
        className="mt-1"
        value={destinationId}
        label="Copy destination ID"
        display={`${destinationId.slice(0, 4)}…${destinationId.slice(-3)}`}
      />
    </details>
  );
}

function initialValues(
  destination: FailureNotificationDestinationResponse | undefined,
): DestinationValues {
  if (destination === undefined)
    return { kind: 'slack', connectionId: null, target: '' };
  const { config } = destination;
  return {
    kind: config.kind,
    connectionId: config.connectionId,
    target: config.kind === 'slack' ? config.channelId : config.toEmail,
  };
}

/**
 * The saved channel's name, or why it isn't shown, while the form still
 * points at that channel through the same connection.
 */
function savedChannelHint(
  destination: FailureNotificationDestinationResponse | undefined,
  values: DestinationValues,
  names: ChannelNames,
): string | undefined {
  const config = destination?.config;
  if (
    config?.kind !== 'slack' ||
    values.connectionId !== config.connectionId ||
    values.target.trim().replace(/^#/u, '') !== config.channelId
  )
    return undefined;
  const { target, note } = describeChannel(
    config.channelId,
    names.get(channelKey(config.connectionId, config.channelId)),
  );
  return note ?? `Posts to ${target}.`;
}

function submitLabel(uncertain: boolean, editing: boolean): string {
  if (uncertain) return 'Try again';
  return editing ? 'Save changes' : 'Add destination';
}

/**
 * A failed save that isn't about one field. A concurrent edit offers the
 * latest version; an unconfirmed save reads as a warning, not a failure.
 */
function SaveFailure({
  error,
  editing,
  refreshing,
  onLoadLatest,
}: Readonly<{
  error: unknown;
  editing: boolean;
  refreshing: boolean;
  onLoadLatest: () => void;
}>) {
  if (isApiError(error) && (error.problem?.errors?.length ?? 0) > 0)
    return null;
  const conflict = editing && isDestinationConflict(error);
  return (
    <Notice
      role="alert"
      tone={conflict || isUncertainOutcome(error) ? 'warning' : 'destructive'}
      action={
        conflict ? (
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={refreshing}
            onClick={onLoadLatest}
          >
            Load latest version
          </Button>
        ) : undefined
      }
    >
      {destinationCommandError(error, editing ? 'update' : 'create')}
    </Notice>
  );
}

/**
 * Add or edit one destination. Editing appends a new version on top of the
 * version the form opened with, so a concurrent edit is refused, not lost.
 */
export function DestinationForm({
  scope,
  destination,
  connections,
  channelNames,
  listRefresh,
  onDone,
  onCancel,
}: Readonly<{
  scope: DestinationMutationScope;
  destination: FailureNotificationDestinationResponse | undefined;
  connections: readonly ConnectionResponse[];
  channelNames: ChannelNames;
  listRefresh: ListRefresh;
  onDone: () => void;
  onCancel: () => void;
}>) {
  const id = useId();
  const notifications = useNotifications();
  const editing = destination !== undefined;
  const [values, setValues] = useState(() => initialValues(destination));
  const [expectedVersion, setExpectedVersion] = useState(
    destination?.currentVersion,
  );
  const validation = useFieldValidation<DestinationField>();
  const create = useCreateFailureNotificationDestinationMutation(scope);
  const append = useAppendFailureNotificationDestinationVersionMutation(scope);
  const mutation = editing ? append : create;
  const attempt =
    useRef<Readonly<{ signature: string; key: string }>>(undefined);
  const errorsFor = (next: DestinationValues) =>
    destinationErrors(next.kind, next.connectionId, next.target, connections);

  function succeed(saved: FailureNotificationDestinationResponse) {
    attempt.current = undefined;
    const { label } = describeDestination(saved, connections, channelNames);
    notifications.success({
      title: editing ? `Saved alerts to ${label}` : `Alerts now go to ${label}`,
    });
    onDone();
  }

  function fail(error: unknown) {
    const issues = isApiError(error) ? (error.problem?.errors ?? []) : [];
    const fields = destinationServerErrors(values.kind, issues);
    if (Object.keys(fields).length > 0) validation.showErrors(fields);
  }

  async function submit() {
    if (mutation.isPending) return;
    if (!validation.submit(errorsFor(values)) || values.connectionId === null)
      return;
    const config = toDestinationConfig(
      values.kind,
      values.connectionId,
      values.target,
    );
    const signature = JSON.stringify({ config, expectedVersion });
    const key =
      attempt.current?.signature === signature
        ? attempt.current.key
        : crypto.randomUUID();
    attempt.current = { signature, key };
    let saved: FailureNotificationDestinationResponse;
    try {
      saved =
        destination === undefined || expectedVersion === undefined
          ? await create.mutateAsync({ config, idempotencyKey: key })
          : await append.mutateAsync({
              destinationId: destination.id,
              expectedVersion,
              config,
              idempotencyKey: key,
            });
    } catch (error) {
      fail(error);
      return;
    }
    succeed(saved);
  }

  async function rebaseOnLatest() {
    const latest = await listRefresh.reload();
    const fresh = latest.find((item) => item.id === destination?.id);
    if (fresh === undefined) return;
    attempt.current = undefined;
    append.reset();
    setExpectedVersion(fresh.currentVersion);
  }

  const conflict =
    editing && mutation.isError && isDestinationConflict(mutation.error);
  const uncertain = mutation.isError && isUncertainOutcome(mutation.error);

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <SheetHeader>
        <SheetTitle>
          {editing ? 'Edit destination' : 'Add destination'}
        </SheetTitle>
        <SheetDescription>
          Pertexo posts here when a run fails, times out or ends with an unknown
          outcome.
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-5">
        {listRefresh.failed ? (
          <StaleLine
            updatedAt={listRefresh.updatedAt}
            retrying={listRefresh.pending}
            onRetry={() => void listRefresh.reload()}
          >
            Your edits here are kept.
          </StaleLine>
        ) : null}
        <FieldGroup>
          <DestinationFields
            id={id}
            workspaceId={scope.workspaceId}
            values={values}
            editing={editing}
            disabled={mutation.isPending}
            connections={connections}
            channelHint={savedChannelHint(destination, values, channelNames)}
            validation={validation}
            errorsFor={errorsFor}
            onChange={(next) => {
              setValues(next);
              if (mutation.isError && !conflict) mutation.reset();
            }}
          />
        </FieldGroup>
        {mutation.isError ? (
          <SaveFailure
            error={mutation.error}
            editing={editing}
            refreshing={listRefresh.pending}
            onLoadLatest={() => void rebaseOnLatest()}
          />
        ) : null}
        {destination === undefined || expectedVersion === undefined ? null : (
          <DestinationDetails
            destinationId={destination.id}
            version={expectedVersion}
          />
        )}
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <ProgressButton
          type="submit"
          variant="primary"
          pending={mutation.isPending}
          pendingLabel="Saving…"
          disabled={
            !editing && usableConnections(connections, values.kind).length === 0
          }
        >
          {submitLabel(uncertain, editing)}
        </ProgressButton>
      </SheetFooter>
    </form>
  );
}
