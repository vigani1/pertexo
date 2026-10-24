import { EllipsisIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { workspaceVariableNameSchema } from '@pertexo/workflow-model';
import { valuePreview, VARIABLE_TYPE_LABELS } from '../model/draft';
import type { VariableRow as Row } from '../model/draft';
const selectClass =
  'recessed-control h-9 w-full rounded-md border px-3 text-base outline-offset-2 md:text-sm focus-visible:outline-2 focus-visible:outline-ring';

type RowActions = Readonly<{
  onChange: (row: Row) => void;
  onOpen: () => void;
  onClose: () => void;
  onInspect: () => void;
  onRemove: () => void;
}>;

/**
 * One variable: a one-line summary, or its fields while it's being edited,
 * as Vercel's and n8n's variable lists do.
 */
export function VariableRow({
  row,
  open,
  unsaved,
  ...actions
}: Readonly<{ row: Row; open: boolean; unsaved: boolean }> & RowActions) {
  return (
    <section
      aria-label={row.name || 'New variable'}
      className="min-w-0 border-b border-border"
    >
      {open ? (
        <VariableForm row={row} {...actions} />
      ) : (
        <VariableSummary row={row} unsaved={unsaved} {...actions} />
      )}
    </section>
  );
}

function VariableSummary({
  row,
  unsaved,
  onOpen,
  onInspect,
  onRemove,
}: Readonly<{ row: Row; unsaved: boolean }> & RowActions) {
  const named = workspaceVariableNameSchema.safeParse(row.name).success;
  const name = row.name || 'Unnamed variable';
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(8rem,15rem)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
          {name}
        </p>
        {row.description === '' ? null : (
          <p className="truncate text-xs text-muted-foreground">
            {row.description}
          </p>
        )}
      </div>
      <p className="col-span-2 row-start-2 flex min-w-0 items-baseline gap-2 sm:col-span-1 sm:row-start-auto">
        <span className="min-w-0 truncate font-mono text-[0.8rem] text-muted-foreground">
          <span className="sr-only">Value: </span>
          {valuePreview(row)}
        </span>
        <span className="shrink-0 text-xs text-subtle-foreground">
          {VARIABLE_TYPE_LABELS[row.type]}
        </span>
      </p>
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-1 sm:col-start-3">
        {unsaved ? <Badge variant="warning">Unsaved</Badge> : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Edit ${name}`}
          onClick={onOpen}
        >
          Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`More actions for ${name}`}
              />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!named} onClick={onInspect}>
              Find references
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function VariableForm({
  row,
  onChange,
  onClose,
  onInspect,
  onRemove,
}: Readonly<{ row: Row }> & RowActions) {
  const prefix = `variable-${row.id}`;
  return (
    <div className="my-3 grid min-w-0 gap-3 rounded-lg border border-border bg-surface-ink/[0.02] p-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <LabelledField id={`${prefix}-name`} label="Name">
          {(control) => (
            <Input
              {...control}
              id={`${prefix}-name`}
              name={`${prefix}.name`}
              className="font-mono"
              value={row.name}
              autoComplete="off"
              spellCheck={false}
              placeholder="CURRENCY"
              maxLength={64}
              onChange={(event) => {
                onChange({ ...row, name: event.currentTarget.value });
              }}
            />
          )}
        </LabelledField>
        <LabelledField id={`${prefix}-type`} label="Type">
          {(control) => (
            <select
              {...control}
              id={`${prefix}-type`}
              name={`${prefix}.type`}
              className={selectClass}
              value={row.type}
              onChange={(event) => {
                const type = event.currentTarget.value;
                if (type === 'text' || type === 'number' || type === 'boolean')
                  onChange({
                    ...row,
                    type,
                    value: EMPTY_VALUES[type],
                  });
              }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">True / false</option>
            </select>
          )}
        </LabelledField>
      </div>
      <LabelledField id={`${prefix}-value`} label="Value">
        {(control) => {
          if (row.type === 'boolean') {
            return (
              <select
                {...control}
                name={`${prefix}.value`}
                className={selectClass}
                value={row.value}
                onChange={(event) => {
                  onChange({ ...row, value: event.currentTarget.value });
                }}
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            );
          }
          if (row.type === 'text') {
            return (
              <Textarea
                {...control}
                name={`${prefix}.value`}
                rows={1}
                // Grows with its text where the browser supports it.
                className="max-h-48 min-h-9 [field-sizing:content]"
                value={row.value}
                maxLength={4096}
                onChange={(event) => {
                  onChange({ ...row, value: event.currentTarget.value });
                }}
              />
            );
          }
          return (
            <Input
              {...control}
              name={`${prefix}.value`}
              type="number"
              step="any"
              value={row.value}
              onChange={(event) => {
                onChange({ ...row, value: event.currentTarget.value });
              }}
            />
          );
        }}
      </LabelledField>
      <LabelledField
        id={`${prefix}-description`}
        label="Description (optional)"
      >
        {(control) => (
          <Input
            {...control}
            name={`${prefix}.description`}
            value={row.description}
            maxLength={500}
            onChange={(event) => {
              onChange({ ...row, description: event.currentTarget.value });
            }}
          />
        )}
      </LabelledField>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!workspaceVariableNameSchema.safeParse(row.name).success}
            onClick={onInspect}
          >
            References
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

const EMPTY_VALUES: Readonly<Record<Row['type'], string>> = {
  text: '',
  number: '0',
  boolean: 'false',
};
