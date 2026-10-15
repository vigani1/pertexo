import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { workspaceVariableNameSchema } from '@pertexo/workflow-model';
import type { VariableRow as Row } from '../model/draft';
const selectClass =
  'recessed-control h-9 w-full rounded-md border px-3 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring';
export function VariableRow({
  row,
  onChange,
  onInspect,
  onRemove,
}: Readonly<{
  row: Row;
  onChange: (row: Row) => void;
  onInspect: () => void;
  onRemove: () => void;
}>) {
  const prefix = `variable-${row.id}`;
  return (
    <section
      aria-label={row.name || 'New variable'}
      className="grid min-w-0 gap-3 border-b border-border py-5 md:grid-cols-[minmax(9rem,1fr)_8rem_minmax(12rem,2fr)_auto]"
    >
      <LabelledField id={`${prefix}-name`} label="Name">
        {(control) => (
          <Input
            {...control}
            id={`${prefix}-name`}
            name={`${prefix}.name`}
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
                  value:
                    type === 'number' ? '0' : type === 'boolean' ? 'false' : '',
                });
            }}
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="boolean">True / false</option>
          </select>
        )}
      </LabelledField>
      <LabelledField id={`${prefix}-value`} label="Value">
        {(control) =>
          row.type === 'boolean' ? (
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
          ) : row.type === 'text' ? (
            <Textarea
              {...control}
              name={`${prefix}.value`}
              rows={1}
              value={row.value}
              maxLength={4096}
              onChange={(event) => {
                onChange({ ...row, value: event.currentTarget.value });
              }}
            />
          ) : (
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
          )
        }
      </LabelledField>
      <div className="flex flex-wrap items-end gap-2">
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
    </section>
  );
}
