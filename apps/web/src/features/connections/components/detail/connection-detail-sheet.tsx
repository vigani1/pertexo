import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
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
import { describeReadError, isNotFound } from '@/lib/api/api-error-copy';
import { cn } from '@/lib/utils';
import type { ConnectionMutationScope } from '../../connections.mutations';
import { connectionDetailQueryOptions } from '../../connections.queries';
import {
  describeConnectionHealth,
  describeConnectionStatus,
} from '../../model/connection-health';
import {
  describeConnectionKind,
  PROVIDERS,
} from '../../model/connection-providers';
import { useConnectionTest } from '../../use-connection-test';
import { ConnectionTestPanel } from '../connection-test/connection-test-panel';
import { ProviderTile } from '../provider-tile';
import { ConnectionFacts } from './connection-facts';
import { ReplaceCredentialForm } from './replace-credential-form';
import { RevokeConnectionDialog } from './revoke-connection-dialog';

type Mode = 'overview' | 'test' | 'replace';

export type ConnectionPermissions = Readonly<{
  canTest: boolean;
  canManage: boolean;
}>;

function ConnectionState({
  connection,
}: Readonly<{ connection: ConnectionResponse }>) {
  const status = describeConnectionStatus(connection.status);
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
        <Notice tone="attention" title="This connection needs reconnecting.">
          {PROVIDERS[connection.providerKey].name} stopped accepting its{' '}
          {PROVIDERS[connection.providerKey].credential}. Replace it to get the
          steps that use it working again.
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
        </>
      ) : null}
      {mode === 'test' ? (
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
      {mode === 'replace' ? (
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
  const connection = connectionId === undefined ? undefined : detail.data;

  return (
    <Sheet
      open={connectionId !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        {connection === undefined ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {detail.isError && isNotFound(detail.error)
                  ? 'Connection not found'
                  : 'Connection'}
              </SheetTitle>
              <SheetDescription>
                {detail.isError
                  ? isNotFound(detail.error)
                    ? 'This connection doesn’t exist, or you don’t have access to it.'
                    : describeReadError(detail.error, 'This connection')
                  : 'Loading…'}
              </SheetDescription>
            </SheetHeader>
            {detail.isError ? null : (
              <SheetBody className="flex flex-col gap-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-24" />
              </SheetBody>
            )}
          </>
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
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
