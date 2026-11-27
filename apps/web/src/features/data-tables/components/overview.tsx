import { UnavailableDataTable } from './unavailable';
import { Link } from '@tanstack/react-router';
import type {
  DataTablesResponse,
  DataTableDefinition,
} from '@pertexo/contracts';
import { EllipsisIcon } from 'lucide-react';
import {
  Empty,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@/components/patterns/states/empty';
import { LooseThread } from '@/components/patterns/states/thread-illustrations';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatByteLength } from '@/lib/format/bytes';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { Row, RowList } from '@/components/patterns/lists/row';
import { pluralWord } from '@/lib/format/count';
/** The workspace's own actions: a new table, and its limits for admins. */
export function WorkspaceTableActions({
  editable,
  admin,
  onDialog,
}: Readonly<{
  editable: boolean;
  admin: boolean;
  onDialog: (dialog: 'create' | 'limits') => void;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
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
      {editable ? (
        <Button
          type="button"
          onClick={() => {
            onDialog('create');
          }}
        >
          New table
        </Button>
      ) : null}
    </div>
  );
}

/** One table's actions: its columns, and delete in the menu. */
export function TableActions({
  onDialog,
}: Readonly<{ onDialog: (dialog: 'remove' | 'columns') => void }>) {
  return (
    <div className="flex gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          onDialog('columns');
        }}
      >
        Edit columns
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="More table actions"
            />
          }
        >
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              onDialog('remove');
            }}
          >
            Delete table
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Every table as a row: its name and key, how many rows it holds. The
 * chosen one lifts; the storage they share sits under the list.
 */
export function TableList({
  tables,
  unavailableTables,
  quotas,
  selectedId,
  workspaceId,
}: Readonly<{
  tables: DataTablesResponse['tables'] | undefined;
  unavailableTables?: DataTablesResponse['unavailableTables'];
  quotas: DataTablesResponse['quotas'] | undefined;
  selectedId: string | undefined;
  workspaceId: string;
}>) {
  if (tables?.length === 0 && (unavailableTables?.length ?? 0) === 0)
    return (
      <Empty>
        <EmptyMedia className="w-full max-w-56">
          <LooseThread />
        </EmptyMedia>
        <EmptyTitle>No tables yet</EmptyTitle>
        <EmptyDescription>
          Create a table to keep orders, reference values or workflow state
          here.
        </EmptyDescription>
      </Empty>
    );
  return (
    <nav aria-label="Tables" className="flex min-w-0 flex-col">
      <h2 className="flex min-w-0 items-center gap-3 font-heading text-section font-semibold">
        Tables
        {quotas === undefined ? null : (
          <span className="font-mono text-caption font-medium text-subtle-foreground">
            {quotas.tableCount} of {quotas.tableLimit}
          </span>
        )}
        <span
          aria-hidden="true"
          className="h-px min-w-3 flex-1 bg-linear-to-r from-border-strong to-border"
        />
      </h2>
      {/* The chosen damaged table says so in the detail, not twice. */}
      {unavailableTables
        ?.filter((item) => item.id !== selectedId)
        .map((item) => (
          <div key={item.id} className="mt-2">
            <UnavailableDataTable name={item.name} />
          </div>
        ))}
      <RowList className="mt-2">
        {tables?.map((item) => {
          const selected = item.id === selectedId;
          return (
            <Row key={item.id} selected={selected} className="p-0">
              <Link
                to="/w/$workspaceId/data-tables/$tableId"
                params={{ workspaceId, tableId: item.id }}
                aria-current={selected ? 'page' : undefined}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-3.5 py-3 outline-none focus-ring"
              >
                <span className="min-w-0">
                  <span className="block truncate text-lead font-semibold">
                    {item.name}
                  </span>
                  <span className="block truncate text-meta text-subtle-foreground">
                    {item.keyColumn === null
                      ? 'no unique key'
                      : `key ${item.keyColumn}`}
                  </span>
                </span>
                <span className="font-mono text-caption text-subtle-foreground tabular-nums">
                  {item.rowCount.toLocaleString(FORMAT_LOCALE)}
                  <span className="sr-only">
                    {' '}
                    {pluralWord(item.rowCount, 'row')}
                  </span>
                </span>
              </Link>
            </Row>
          );
        })}
      </RowList>
      {quotas === undefined ? null : (
        <p className="mt-3.5 font-mono text-caption text-subtle-foreground">
          storage {formatByteLength(quotas.storedBytes)} of{' '}
          {formatByteLength(quotas.byteLimit)}
        </p>
      )}
    </nav>
  );
}
