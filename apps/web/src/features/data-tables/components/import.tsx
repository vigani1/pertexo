import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { FileDrop } from '@/components/ui/file-drop';
import { Textarea } from '@/components/ui/textarea';
import { FieldLabel as Label } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
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
export function ImportTableCsv({
  scope,
  table,
  onClose,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  onClose: () => void;
}>) {
  const cache = useQueryClient();
  const [csv, setCsv] = useState('');
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const command = useRetainedCommand(
    (body: { csv: string }, key: string) =>
      sendTableCommand(scope, { kind: 'import', tableId: table.id, body }, key),
    async () => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
      onClose();
    },
    { action: 'importing these rows' },
  );
  const locked = command.pending || command.uncertain || reading;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Import CSV</DialogTitle>
        <DialogDescription>
          Up to 1 MB and 1,000 rows; split larger files. Every row must match{' '}
          {table.name}. The whole import is saved together.
        </DialogDescription>
        <form
          className="mt-5 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              new TextEncoder().encode(JSON.stringify({ csv })).length >
              1_048_000
            ) {
              setError('The request is larger than 1 MB. Split the CSV file.');
              return;
            }
            void command.send({ csv });
          }}
        >
          <Label htmlFor="csv-file">Choose a UTF-8 CSV file</Label>
          <FileDrop
            id="csv-file"
            aria-label="Choose a UTF-8 CSV file"
            accept=".csv,text/csv"
            disabled={locked}
            onChoose={(file) => {
              if (file.size > 1_048_576) {
                setError('This file exceeds 1 MB. Split it before importing.');
                return;
              }
              setReading(true);
              void file
                .text()
                .then((text) => {
                  setCsv(text);
                  setError(undefined);
                })
                .catch(() => {
                  setError('The file could not be read.');
                })
                .finally(() => {
                  setReading(false);
                });
            }}
          />
          <div className="grid gap-2">
            <Label htmlFor="csv-text">Or paste CSV</Label>
            <Textarea
              id="csv-text"
              className="font-mono text-base md:text-xs"
              rows={8}
              disabled={locked}
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
              }}
              placeholder={table.columns.map((column) => column.name).join(',')}
              required
            />
          </div>
          <p className="break-words text-xs text-muted-foreground">
            Header: {table.columns.map((column) => column.name).join(', ')}.
            Numbers and true/false use the column type. JSON cells need valid
            JSON.
          </p>
          {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
          <TableCommandFeedback command={command} />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={locked || csv === ''}
            >
              {command.pending ? 'Importing…' : 'Import rows'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
