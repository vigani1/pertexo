import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConnectionResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { describeReadError, isNotFound } from '@/lib/api/error-copy';
import { cn } from '@/lib/utils';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import { connectionAccessLost } from '../../model/connection-access';
import type { ConnectionMutationScope } from '../../data/connections.mutations';
import { connectionDetailQueryOptions } from '../../data/connections.queries';
import {
  describeConnectionHealth,
  describeConnectionStatus,
} from '../../model/connection-health';
import {
  describeConnectionKind,
  PROVIDERS,
} from '../../model/connection-providers';
import { useConnectionTest } from '../connection-test/use-test';
import { ConnectionTestPanel } from '../connection-test/panel';
import { ProviderTile } from '../provider-tile';
import { ConnectionFacts } from './connection-facts';
import { ReplaceCredentialForm } from './replace-credential-form';
import { RevokeConnectionDialog } from './revoke-connection-dialog';
import { ConnectionUsage } from './connection-usage';

type Mode = 'overview' | 'test' | 'replace';

function ConnectionReadState({
  error,
  failed,
  retrying,
  onRetry,
}: Readonly<{
  error: unknown;
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
}>) {
  const missing = failed && isNotFound(error);
  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {missing ? 'Connection not found' : 'Connection'}
        </SheetTitle>
        <SheetDescription>
          {failed ? (
            missing ? (
              'This connection doesn’t exist, or you don’t have access to it.'
            ) : (
              describeReadError(error, 'This connection')
            )
          ) : (
            <span className="skeleton-wait">Loading…</span>
          )}
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-3">
        {failed ? (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={retrying}
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : (
          <>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-24" />
          </>
        )}
      </SheetBody>
    </>
  );
}

export type ConnectionPermissions = Readonly<{
  canTest: boolean;
  canManage: boolean;
  canReadUsage?: boolean;
}>;

function ConnectionState({
  connection,
}: Readonly<{ connection: ConnectionResponse }>) {
  const status = describeConnectionStatus(connection.status, connection.health);
  const health = describeConnectionHealth(connection);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Status tone={status.tone}>{status.label}</Status>
      <span
        className={cn(
          'font-mono text-xs',
          health.tone === 'attention'
            ? 'text-warning'
            : 'text-subtle-foreground',
        )}
      >
        {health.text}
      </span>
    </div>
  );
}

function OverviewActions({
  connection,
  permissions,
  onMode,
  scope,
}: Readonly<{
  connection: ConnectionResponse;
  permissions: ConnectionPermissions;
  onMode: (mode: Mode) => void;
  scope: ConnectionMutationScope;
}>) {
  if (connection.status === 'revoked') return null;
  const reconnect = connection.status === 'reauthorization_required';
  return (
    <>
      {reconnect ? (
        <Notice tone="warning" title="This connection needs reconnecting.">
          {PROVIDERS[connection.providerKey].name} stopped accepting its{' '}
          {PROVIDERS[connection.providerKey].credential}. Replace it to get the
          steps that use it working again, or test it to check whether access
          has been restored.
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {permissions.canTest ? (
          <Button
            type="button"
            variant={reconnect ? 'outline' : 'default'}
            onClick={() => {
              onMode('test');
            }}
          >
            Test
          </Button>
        ) : null}
        {permissions.canManage ? (
          <Button
            type="button"
            variant={reconnect ? 'primary' : 'outline'}
            onClick={() => {
              onMode('replace');
            }}
          >
            Replace credential
          </Button>
        ) : null}
      </div>
      {permissions.canManage ? (
        <>
          <Separator />
          <section
            aria-label="Danger zone"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <p className="max-w-64 text-sm text-muted-foreground">
              Revoking stops every step and alert that uses it.
            </p>
            <RevokeConnectionDialog scope={scope} connection={connection} />
          </section>
        </>
      ) : null}
    </>
  );
}

function DetailBody({
  scope,
  connection,
  permissions,
}: Readonly<{
  scope: ConnectionMutationScope;
  connection: ConnectionResponse;
  permissions: ConnectionPermissions;
}>) {
  const [mode, setMode] = useState<Mode>('overview');
  const test = useConnectionTest(scope);
  const back = () => {
    setMode('overview');
  };
  return (
    <SheetBody className="flex flex-col gap-5">
      <ConnectionState connection={connection} />
      {mode === 'overview' ? (
        <>
          <OverviewActions
            connection={connection}
            permissions={permissions}
            onMode={setMode}
            scope={scope}
          />
          <Separator />
          <ConnectionFacts connection={connection} />
          <Separator />
          <ConnectionUsage
            scope={scope}
            connectionId={connection.id}
            canRead={permissions.canReadUsage ?? false}
          />
        </>
      ) : null}
      {mode === 'test' &&
      permissions.canTest &&
      connection.status !== 'revoked' ? (
        <>
          <ConnectionTestPanel
            provider={connection.providerKey}
            test={test}
            onRun={(request) => {
              test.run(connection, request);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            className="self-start"
            disabled={test.phase === 'running'}
            onClick={back}
          >
            Back to details
          </Button>
        </>
      ) : null}
      {mode === 'replace' &&
      permissions.canManage &&
      connection.status !== 'revoked' ? (
        <ReplaceCredentialForm
          scope={scope}
          connection={connection}
          onDone={back}
        />
      ) : null}
    </SheetBody>
  );
}

/**
 * The detail lens, backed by the single-connection read. Test, replace and
 * revoke live here instead of in every row.
 */
export function ConnectionDetailSheet({
  scope,
  connectionId,
  placeholder,
  permissions,
  onClose,
}: Readonly<{
  scope: ConnectionMutationScope;
  connectionId: string | undefined;
  placeholder: ConnectionResponse | undefined;
  permissions: ConnectionPermissions;
  onClose: () => void;
}>) {
  const detail = useQuery({
    ...connectionDetailQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      connectionId ?? '',
    ),
    enabled: connectionId !== undefined,
    ...(placeholder === undefined ? {} : { placeholderData: placeholder }),
  });
  const connection =
    connectionId === undefined ||
    (detail.isError && connectionAccessLost(detail.error))
      ? undefined
      : detail.data;

  return (
    <Sheet
      open={connectionId !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        {connection === undefined ? (
          <ConnectionReadState
            error={detail.error}
            failed={detail.isError}
            retrying={detail.isFetching}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <SheetHeader className="flex-row items-center gap-3">
              <ProviderTile provider={connection.providerKey} size="lg" />
              <div className="min-w-0">
                <SheetTitle className="truncate">{connection.name}</SheetTitle>
                <SheetDescription>
                  {describeConnectionKind(connection.providerKey)}
                </SheetDescription>
              </div>
            </SheetHeader>
            <DetailBody
              key={connection.id}
              scope={scope}
              connection={connection}
              permissions={permissions}
            />
            {detail.isError ? (
              <SheetBody>
                <ReadFailure
                  resource="This connection"
                  error={detail.error}
                  showing={true}
                  updatedAt={detail.dataUpdatedAt}
                  retrying={detail.isRefetching}
                  onRetry={() => void detail.refetch()}
                />
              </SheetBody>
            ) : null}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
