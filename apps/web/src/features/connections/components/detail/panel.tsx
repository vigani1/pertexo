import { useConnectionDefinitions } from '@/features/catalog/public';
import { useConnectionSharingEditor } from '../../data/sharing.mutations';
import { ConnectionSharingPanel } from '../connection-sharing';
import { NoticeSubjectActions } from '@/features/inbox/inbox-views.public';
import { useLayoutEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockIcon } from 'lucide-react';
import type { ConnectionResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { useNotifications } from '@/components/ui/use-notifications';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { cn } from '@/lib/class-names';
import { QueryView } from '@/components/patterns/states/query-view';
import { isReadAccessLost } from '@/lib/api/read-denial';
import type { ConnectionMutationScope } from '../../data/connections.mutations';
import { connectionDetailQueryOptions } from '../../data/connections.queries';
import {
  describeConnectionHealth,
  describeConnectionStatus,
} from '../../model/connection-health';
import {
  connectionDefinition,
  describeConnectionKind,
  connectionPresentation,
} from '../../model/connection-providers';
import { useConnectionTest } from '../../data/connection-test.mutations';
import { ConnectionTestPanel } from '../connection-test/panel';
import { ProviderTile } from '../provider-tile';
import { ConnectionDetails, ConnectionFacts } from './connection-facts';
import { isOAuth2Connection } from '../../model/oauth2-copy';
import { OAuth2OverviewActions } from '../oauth2/overview-actions';
import { ReplaceCredentialForm } from './replace-credential-form';
import { RevokeConnectionDialog } from './revoke-connection-dialog';
import { ConnectionUsage } from './connection-usage';
import { ConnectionLoading, ConnectionUnreadable } from './read-state';

type Mode = 'overview' | 'test' | 'replace' | 'sharing';

export type ConnectionPermissions = Readonly<{
  canTest: boolean;
  canManage: boolean;
  canReadUsage?: boolean;
  canFollow?: boolean;
}>;

function ConnectionState({
  connection,
}: Readonly<{ connection: ConnectionResponse }>) {
  const status = describeConnectionStatus(connection.status, connection.health);
  const definitions = useConnectionDefinitions();
  const health = describeConnectionHealth(
    connection,
    undefined,
    connectionDefinition(
      definitions,
      connection.providerKey,
      connection.authType,
    ),
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <StatusMark tone={status.tone}>{status.label}</StatusMark>
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
  scope,
  connection,
  permissions,
  onMode,
}: Readonly<{
  scope: ConnectionMutationScope;
  connection: ConnectionResponse;
  permissions: ConnectionPermissions;
  onMode: (mode: Mode) => void;
}>) {
  const definitions = useConnectionDefinitions();
  const provider = connectionPresentation(definitions, connection.providerKey);
  if (connection.status === 'revoked') return null;
  if (isOAuth2Connection(connection))
    return (
      <OAuth2OverviewActions
        scope={scope}
        connection={connection}
        canTest={permissions.canTest}
        canManage={permissions.canManage}
        onMode={onMode}
      />
    );
  const reconnect = connection.status === 'reauthorization_required';
  return (
    <>
      {reconnect ? (
        <Notice tone="warning" title="This connection needs reconnecting.">
          {provider.name} stopped accepting its {provider.credential}. Replace
          it to get the steps that use it working again, or test it to check
          whether access has been restored.
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
    <div className="flex flex-col gap-5">
      {mode === 'overview' ? (
        <>
          <OverviewActions
            scope={scope}
            connection={connection}
            permissions={permissions}
            onMode={setMode}
          />
          <ConnectionState connection={connection} />
          <ConnectionFacts connection={connection} />
          <ConnectionUsage
            scope={scope}
            connectionId={connection.id}
            connectionName={connection.name}
            canRead={permissions.canReadUsage ?? false}
          />
          <ConnectionDetails connection={connection} />
          {permissions.canFollow === false ? null : (
            <>
              <NoticeSubjectActions
                scope={scope}
                subject={{
                  subjectKind: 'connection',
                  subjectId: connection.id,
                }}
                name={connection.name}
              />
            </>
          )}
          {/* Last, after everything it would stop. */}
          {permissions.canManage && connection.status !== 'revoked' ? (
            <>
              <section
                aria-label="Danger zone"
                className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"
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
      {mode === 'overview' ? null : <ConnectionState connection={connection} />}
      {mode === 'test' &&
      permissions.canTest &&
      connection.status !== 'revoked' ? (
        <>
          <Button
            type="button"
            variant="ghost"
            className="self-start"
            disabled={test.phase === 'running'}
            onClick={back}
          >
            Back to details
          </Button>
          <ConnectionTestPanel
            provider={connection.providerKey}
            authType={connection.authType}
            test={test}
            onRun={(request) => {
              test.run(connection, request);
            }}
          />
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
    </div>
  );
}

/**
 * The chosen connection beside the list, backed by the single-connection
 * read. Test, replace and revoke live here instead of in every row.
 */
function ConnectionDetailSession({
  scope,
  connectionId,
  placeholder,
  permissions,
  onCloseLockChange,
}: Readonly<{
  scope: ConnectionMutationScope;
  connectionId: string;
  placeholder: ConnectionResponse | undefined;
  permissions: ConnectionPermissions;
  onCloseLockChange: (locked: boolean) => void;
}>) {
  const definitions = useConnectionDefinitions();
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
  useLayoutEffect(() => {
    onCloseLockChange(sharing.closeLocked);
    return () => {
      onCloseLockChange(false);
    };
  }, [onCloseLockChange, sharing.closeLocked]);
  const detail = useQuery({
    ...connectionDetailQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      connectionId,
    ),
    ...(placeholder === undefined ? {} : { placeholderData: placeholder }),
  });
  return (
    <QueryView
      query={detail}
      resource="This connection"
      loading={<ConnectionLoading />}
      failure={(error) =>
        isReadAccessLost(error) ? (
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
        <article
          data-slot="connection-detail"
          aria-labelledby="connection-name"
          className="flex min-w-0 flex-col gap-5"
        >
          <header className="flex items-center gap-3">
            <ProviderTile provider={connection.providerKey} size="lg" />
            <div className="min-w-0">
              <h2
                id="connection-name"
                className="truncate font-heading text-2xl font-semibold"
              >
                {connection.name}
              </h2>
              <p className="text-meta text-subtle-foreground">
                {describeConnectionKind(
                  definitions,
                  connection.providerKey,
                  connection.authType,
                )}
                , stored encrypted
              </p>
              {connection.accessMode === 'restricted' ? (
                <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LockIcon aria-hidden="true" className="size-3" />
                  Only chosen people can use it
                </p>
              ) : null}
            </div>
          </header>
          <DetailBody
            key={connection.id}
            scope={scope}
            connection={connection}
            permissions={permissions}
            sharing={sharing}
            mode={mode}
            onMode={setMode}
          />
        </article>
      )}
    </QueryView>
  );
}

export function ConnectionDetail(
  props: Readonly<{
    scope: ConnectionMutationScope;
    connectionId: string;
    placeholder: ConnectionResponse | undefined;
    permissions: ConnectionPermissions;
    onCloseLockChange: (locked: boolean) => void;
  }>,
) {
  return (
    <ConnectionDetailSession
      key={`${props.scope.userId}:${props.scope.workspaceId}:${props.connectionId}`}
      {...props}
    />
  );
}
