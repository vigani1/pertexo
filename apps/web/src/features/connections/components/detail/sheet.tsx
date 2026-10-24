import { useConnectionSharingEditor } from '../../hooks/use-sharing-editor';
import { ConnectionSharingPanel } from '../sharing/panel';
import { NoticeSubjectActions } from '@/features/inbox/subscriptions.public';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockIcon } from 'lucide-react';
import type { ConnectionResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Separator } from '@/components/ui/separator';
import { useNotifications } from '@/components/ui/use-notifications';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { QueryView } from '@/components/patterns/states/query-view';
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
import { ConnectionLoading } from './read-state';
import { ConnectionUnreadable } from './read-state';

type Mode = 'overview' | 'test' | 'replace' | 'sharing';

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
}: Readonly<{
  connection: ConnectionResponse;
  permissions: ConnectionPermissions;
  onMode: (mode: Mode) => void;
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
          <>
            <Button
              type="button"
              variant={reconnect ? 'primary' : 'outline'}
              onClick={() => {
                onMode('replace');
              }}
            >
              Replace credential
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onMode('sharing');
              }}
            >
              Share
            </Button>
          </>
        ) : null}
      </div>
    </>
  );
}

function DetailBody({
  scope,
  connection,
  permissions,
  sharing,
  mode,
  onMode: setMode,
}: Readonly<{
  scope: ConnectionMutationScope;
  connection: ConnectionResponse;
  permissions: ConnectionPermissions;
  sharing: ReturnType<typeof useConnectionSharingEditor>;
  mode: Mode;
  onMode: (mode: Mode) => void;
}>) {
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
          />
          <Separator />
          <ConnectionFacts connection={connection} />
          <Separator />
          <ConnectionUsage
            scope={scope}
            connectionId={connection.id}
            canRead={permissions.canReadUsage ?? false}
          />
          <Separator />
          <NoticeSubjectActions
            scope={scope}
            subject={{ subjectKind: 'connection', subjectId: connection.id }}
            name={connection.name}
          />
          {/* Last, after everything it would stop. */}
          {permissions.canManage && connection.status !== 'revoked' ? (
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
      {mode === 'sharing' && permissions.canManage ? (
        <ConnectionSharingPanel scope={scope} editor={sharing} onDone={back} />
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
function ConnectionDetailSession({
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
  const [mode, setMode] = useState<Mode>('overview');
  const notifications = useNotifications();
  const sharing = useConnectionSharingEditor(
    scope,
    permissions.canManage ? connectionId : undefined,
    () => {
      notifications.success({ title: 'Sharing saved' });
      setMode('overview');
    },
  );
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
  return (
    <Sheet
      open={connectionId !== undefined}
      onOpenChange={(open) => {
        if (!open && !sharing.closeLocked) onClose();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        {connectionId === undefined ? null : (
          <QueryView
            query={detail}
            resource="This connection"
            loading={<ConnectionLoading />}
            failure={(error) =>
              connectionAccessLost(error) ? (
                <ConnectionUnreadable error={error} />
              ) : undefined
            }
            error={({ error, retrying, retry }) => (
              <ConnectionUnreadable
                error={error}
                retrying={retrying}
                onRetry={retry}
              />
            )}
          >
            {(connection) => (
              <>
                <SheetHeader className="flex-row items-center gap-3">
                  <ProviderTile provider={connection.providerKey} size="lg" />
                  <div className="min-w-0">
                    <SheetTitle className="truncate">
                      {connection.name}
                    </SheetTitle>
                    <SheetDescription>
                      {describeConnectionKind(connection.providerKey)}
                    </SheetDescription>
                    {connection.accessMode === 'restricted' ? (
                      <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <LockIcon aria-hidden="true" className="size-3" />
                        Only chosen people can use it
                      </p>
                    ) : null}
                  </div>
                </SheetHeader>
                <DetailBody
                  key={connection.id}
                  scope={scope}
                  connection={connection}
                  permissions={permissions}
                  sharing={sharing}
                  mode={mode}
                  onMode={setMode}
                />
              </>
            )}
          </QueryView>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function ConnectionDetailSheet(
  props: Readonly<{
    scope: ConnectionMutationScope;
    connectionId: string | undefined;
    placeholder: ConnectionResponse | undefined;
    permissions: ConnectionPermissions;
    onClose: () => void;
  }>,
) {
  return (
    <ConnectionDetailSession
      key={`${props.scope.userId}:${props.scope.workspaceId}:${props.connectionId ?? 'closed'}`}
      {...props}
    />
  );
}
