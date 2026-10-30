import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  dataTableLimitsSchema,
  type DataTablesResponse,
} from '@pertexo/contracts';
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
import { Notice } from '@/components/ui/notice';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { sendTableCommand, type TableScope } from '../data/tables.api';
import { tableKeys } from '../data/tables.queries';
import { TableCommandFeedback } from './command-feedback';
import { ADMINISTRATORS } from '@/features/workspaces/roles.public';
import { sentenceStart } from '@/lib/format/sentence';
export function DataTableLimits({
  scope,
  quotas,
  onClose,
}: Readonly<{
  scope: TableScope;
  quotas: DataTablesResponse['quotas'];
  onClose: () => void;
}>) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState(() => ({
    tableLimit: String(quotas.tableLimit),
    columnLimit: String(quotas.columnLimit),
    rowLimit: String(quotas.rowLimit),
    megabytes: String(quotas.byteLimit / 1_048_576),
  }));
  const [error, setError] = useState<string>();
  const command = useRetainedCommand(
    (body: ReturnType<typeof dataTableLimitsSchema.parse>, key: string) =>
      sendTableCommand(scope, { kind: 'limits', body }, key),
    async () => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
      onClose();
    },
    { action: 'changing table limits' },
  );
  const locked = command.pending || command.uncertain;
  const fields = [
    { key: 'tableLimit', label: 'Tables', max: 100 },
    { key: 'columnLimit', label: 'Columns per table', max: 50 },
    { key: 'rowLimit', label: 'Rows per table', max: 100_000 },
    { key: 'megabytes', label: 'Workspace storage (MB)', max: 1024 },
  ] as const;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Data table limits</DialogTitle>
        <DialogDescription>
          {sentenceStart(ADMINISTRATORS)} can raise these bounded defaults.
          Limits cannot be below current use.
        </DialogDescription>
        <form
          className="mt-5 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = dataTableLimitsSchema.safeParse({
              tableLimit: Number(draft.tableLimit),
              columnLimit: Number(draft.columnLimit),
              rowLimit: Number(draft.rowLimit),
              byteLimit: Number(draft.megabytes) * 1_048_576,
            });
            if (!parsed.success) {
              setError(parsed.error.issues[0]?.message);
              return;
            }
            void command.send(parsed.data);
          }}
        >
          {fields.map((field) => (
            <div key={field.key} className="grid gap-2">
              <Label htmlFor={`limit-${field.key}`}>{field.label}</Label>
              <Input
                id={`limit-${field.key}`}
                type="number"
                min={1}
                max={field.max}
                step={1}
                required
                disabled={locked}
                value={draft[field.key]}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }));
                }}
              />
            </div>
          ))}
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
            <Button type="submit" variant="primary" disabled={locked}>
              Save limits
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
