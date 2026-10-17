import { useId } from 'react';
import { auditFilterSchema, type AuditFilter } from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useFieldValues } from '@/components/ui/use-field-validation';
const names = [
  'person',
  'action',
  'targetType',
  'targetId',
  'from',
  'until',
] as const;
const labels = {
  person: 'Person name',
  action: 'Action',
  targetType: 'Target type',
  targetId: 'Target ID',
  from: 'From (UTC)',
  until: 'Before (UTC)',
};
function filterValue(
  name: (typeof names)[number],
  value: string,
): string | undefined {
  if (value === '') return undefined;
  return name === 'from' || name === 'until' ? `${value}:00Z` : value;
}
export function AuditFilters({
  filters,
  onApply,
}: Readonly<{
  filters: AuditFilter;
  onApply: (filters: AuditFilter) => void;
}>) {
  const id = useId();
  const fields = useFieldValues(
    Object.fromEntries(
      names.map((name) => [
        name,
        (value: string) => {
          const schema = auditFilterSchema.shape[name];
          const parsed = schema.safeParse(filterValue(name, value));
          return parsed.success ? undefined : parsed.error.issues[0]?.message;
        },
      ]),
    ) as Record<(typeof names)[number], (value: string) => string | undefined>,
    {
      person: filters.person ?? '',
      action: filters.action ?? '',
      targetType: filters.targetType ?? '',
      targetId: filters.targetId ?? '',
      from: filters.from?.slice(0, 16) ?? '',
      until: filters.until?.slice(0, 16) ?? '',
    },
  );
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const values = fields.validate();
        if (values === undefined) return;
        const parsed = auditFilterSchema.safeParse(
          Object.fromEntries(
            names
              .filter((name) => values[name] !== '')
              .map((name) => [name, filterValue(name, values[name])]),
          ),
        );
        if (!parsed.success) {
          fields.showErrors({ until: 'The end must be after the start.' });
          return;
        }
        onApply(parsed.data);
      }}
    >
      {names.map((name) => (
        <LabelledField
          key={name}
          id={`${id}-${name}`}
          label={labels[name]}
          error={fields.error(name)}
          description={
            name === 'from' || name === 'until' ? 'Times use UTC.' : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              {...fields.control(name)}
              type={
                name === 'from' || name === 'until' ? 'datetime-local' : 'text'
              }
              step={name === 'from' || name === 'until' ? 60 : undefined}
              maxLength={name === 'person' ? 256 : 128}
            />
          )}
        </LabelledField>
      ))}
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" variant="outline">
          Apply filters
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            fields.reset({
              person: '',
              action: '',
              targetType: '',
              targetId: '',
              from: '',
              until: '',
            });
            onApply({});
          }}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}
