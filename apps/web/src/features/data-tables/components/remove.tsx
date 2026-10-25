import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldLabel as Label } from '@/components/ui/field';
import {
  Dialog,
  DialogFooter,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { sendTableCommand, type TableScope } from '../data/tables.api';
import { tableKeys } from '../data/tables.queries';
import { TableCommandFeedback } from './command-feedback';
export function RemoveDataTable({
  scope,
  table,
  onClose,
  onRemoved,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  onClose: () => void;
  onRemoved: () => void;
}>) {
  const cache = useQueryClient();
  const [confirmation, setConfirmation] = useState('');
  const command = useRetainedCommand(
    (revision: number, key: string) =>
      sendTableCommand(
        scope,
        {
          kind: 'remove',
          tableId: table.id,
          body: { expectedRevision: revision },
        },
        key,
      ),
    async () => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
      onRemoved();
      onClose();
    },
    { action: 'deleting this table' },
  );
  const locked = command.pending || command.uncertain;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Delete {table.name}?</DialogTitle>
        <DialogDescription>
          This removes every row. Workflows using this table name will fail
          until you change their setup or deliberately recreate that name.
        </DialogDescription>
        <form
          className="mt-5 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmation === table.name) void command.send(table.revision);
          }}
        >
          <Label htmlFor="delete-table-confirm">
            Type {table.name} to confirm
          </Label>
          <Input
            id="delete-table-confirm"
            value={confirmation}
            disabled={locked}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
            autoComplete="off"
          />
          <TableCommandFeedback command={command} />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={locked}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={locked || confirmation !== table.name}
            >
              Delete table
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
