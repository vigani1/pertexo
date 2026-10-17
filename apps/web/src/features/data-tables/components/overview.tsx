import { Link } from '@tanstack/react-router';
import type {
  DataTablesResponse,
  DataTableDefinition,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { formatByteLength } from '@/lib/format/bytes';
export function TablePageActions({
  detail,
  editable,
  admin,
  table,
  onOpen,
  onDialog,
}: Readonly<{
  detail: boolean;
  editable: boolean;
  admin: boolean;
  table: DataTableDefinition | undefined;
  onOpen: (id: string | undefined) => void;
  onDialog: (dialog: 'create' | 'limits' | 'remove') => void;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
      {detail ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onOpen(undefined);
          }}
        >
          All tables
        </Button>
      ) : editable ? (
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            onDialog('create');
          }}
        >
          New table
        </Button>
      ) : null}
      {admin ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onDialog('limits');
          }}
        >
          Table limits
        </Button>
      ) : null}
      {table !== undefined && editable ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onDialog('remove');
          }}
        >
          Delete table
        </Button>
      ) : null}
    </div>
  );
}
export function TableCapacity({
  quotas,
}: Readonly<{ quotas: DataTablesResponse['quotas'] | undefined }>) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3 border-y border-border py-4 text-sm">
      <p className="flex items-center gap-2">
        <StatusGlyph tone="live" />
        Shared data, inside this workspace.
      </p>
      {quotas === undefined ? null : (
        <>
          <p>
            {quotas.tableCount} / {quotas.tableLimit} tables
          </p>
          <p>
            {formatByteLength(quotas.storedBytes)} /{' '}
            {formatByteLength(quotas.byteLimit)}
          </p>
        </>
      )}
    </div>
  );
}
export function TableCollection({
  tables,
  workspaceId,
}: Readonly<{
  tables: DataTablesResponse['tables'] | undefined;
  workspaceId: string;
}>) {
  return (
    <div className="divide-y divide-border">
      {tables?.map((item) => (
        <Link
          key={item.id}
          to="/w/$workspaceId/data-tables/$tableId"
          params={{ workspaceId, tableId: item.id }}
          className="group flex min-w-0 items-center gap-4 py-5"
        >
          <StatusGlyph tone={item.rowCount > 0 ? 'success' : 'neutral'} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium group-hover:text-action">
              {item.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {item.columns.length} columns
              {item.keyColumn === null ? '' : ` · key: ${item.keyColumn}`}
            </p>
          </div>
          <p className="text-right text-sm tabular-nums">
            {item.rowCount.toLocaleString()} rows
            <br />
            <span className="text-xs text-muted-foreground">
              {formatByteLength(item.storedBytes)}
            </span>
          </p>
        </Link>
      ))}
      {tables?.length === 0 ? (
        <div className="flex items-center gap-4 py-10">
          <StatusGlyph tone="success" />
          <div>
            <p>No tables yet.</p>
            <p className="text-sm text-muted-foreground">
              Keep a small list of orders, reference values or workflow state
              here.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
