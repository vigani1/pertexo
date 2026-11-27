import { useConnectionDefinitions } from '@/features/catalog/public';
import type { ConnectionResponse } from '@pertexo/contracts';
import { LockIcon } from 'lucide-react';
import { Row, RowList } from '@/components/patterns/lists/row';
import { StatusMark } from '@/components/patterns/status/status-mark';
import {
  describeConnectionHealth,
  describeConnectionStatus,
} from '../model/connection-health';
import {
  connectionDefinition,
  describeConnectionKind,
} from '../model/connection-providers';

function ConnectionRow({
  connection,
  selected,
  onOpen,
}: Readonly<{
  connection: ConnectionResponse;
  selected: boolean;
  onOpen: (connectionId: string) => void;
}>) {
  const status = describeConnectionStatus(connection.status, connection.health);
  const definitions = useConnectionDefinitions();
  // Only a connection that needs something says more than its kind.
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
    <Row selected={selected} className="p-0">
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-label={`${connection.name}, ${status.label}`}
        className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3.5 py-3 text-left outline-none focus-ring"
        onClick={() => {
          onOpen(connection.id);
        }}
      >
        <StatusMark tone={status.tone} display="mark" />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5 text-lead font-semibold">
            <span className="truncate">{connection.name}</span>
            {connection.accessMode === 'restricted' ? (
              <LockIcon
                role="img"
                aria-label="Only chosen people can use it"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
          </span>
          <span className="block truncate text-meta text-subtle-foreground">
            {describeConnectionKind(
              definitions,
              connection.providerKey,
              connection.authType,
            )}
          </span>
          {health.tone === 'attention' ? (
            <span className="block truncate font-mono text-caption text-warning">
              {health.text}
            </span>
          ) : null}
        </span>
      </button>
    </Row>
  );
}

export function ConnectionList({
  connections,
  selectedId,
  onOpen,
}: Readonly<{
  connections: readonly ConnectionResponse[];
  selectedId: string | undefined;
  onOpen: (connectionId: string) => void;
}>) {
  return (
    <RowList aria-label="Connections">
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          connection={connection}
          selected={connection.id === selectedId}
          onOpen={onOpen}
        />
      ))}
    </RowList>
  );
}
