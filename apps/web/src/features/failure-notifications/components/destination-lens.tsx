import { useId, useRef, useState } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FieldGroup } from '@/components/ui/field';
import { LoadingOrb } from '@/components/ui/loading-orb';
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
      <p className="mt-1 flex items-center gap-1 font-mono text-xs">
        {destinationId.slice(0, 4)}…{destinationId.slice(-3)}
        <CopyButton value={destinationId} label="Copy destination ID" />
      </p>
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
 * Add or edit one destination. Editing appends a new version on top of the
 * version the form opened with, so a concurrent edit is refused, not lost.
 */
export function DestinationForm({
  scope,
  destination,
  connections,
  listRefresh,
  onDone,
  onCancel,
}: Readonly<{
  scope: DestinationMutationScope;
  destination: FailureNotificationDestinationResponse | undefined;
  connections: readonly ConnectionResponse[];
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
    const { label } = describeDestination(saved, connections);
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
  const hasFieldIssues =
    mutation.isError &&
    isApiError(mutation.error) &&
    (mutation.error.problem?.errors?.length ?? 0) > 0;

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
            validation={validation}
            errorsFor={errorsFor}
            onChange={(next) => {
              setValues(next);
              if (mutation.isError && !conflict) mutation.reset();
            }}
          />
        </FieldGroup>
        {mutation.isError && !hasFieldIssues ? (
          <Notice
            role="alert"
            tone={uncertain || conflict ? 'warning' : 'destructive'}
            action={
              conflict ? (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={listRefresh.pending}
                  onClick={() => void rebaseOnLatest()}
                >
                  Load latest version
                </Button>
              ) : undefined
            }
          >
            {destinationCommandError(
              mutation.error,
              editing ? 'update' : 'create',
            )}
          </Notice>
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
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? <LoadingOrb data-icon="inline-start" /> : null}
          {mutation.isPending
            ? 'Saving…'
            : uncertain
              ? 'Try again'
              : editing
                ? 'Save changes'
                : 'Add destination'}
        </Button>
      </SheetFooter>
    </form>
  );
}
