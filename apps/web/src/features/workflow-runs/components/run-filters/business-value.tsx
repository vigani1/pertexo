import { useId, useState } from 'react';
import { runValueKeySchema, runValueTextSchema } from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Disclosure } from '@/components/ui/disclosure';
import type { RunSearch } from '../../model/list/run-search';
export function BusinessValueFilter({
  search,
  onSearchChange,
}: Readonly<{
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
}>) {
  return (
    <Disclosure summary="Run value" look="framed" lazy>
      <ExactValueFields
        key={JSON.stringify([search.runValueKey, search.runValue])}
        search={search}
        onSearchChange={onSearchChange}
      />
    </Disclosure>
  );
}
function ExactValueFields({
  search,
  onSearchChange,
}: Readonly<{
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
}>) {
  const id = useId();
  const [key, setKey] = useState(search.runValueKey ?? '');
  const [value, setValue] = useState(search.runValue ?? '');
  const [error, setError] = useState<string>();
  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !runValueKeySchema.safeParse(key).success ||
          !runValueTextSchema.safeParse(value).success
        ) {
          setError(
            'Use a key of up to 50 letters, numbers, dots, hyphens or underscores, and a text value up to 255 characters.',
          );
          return;
        }
        setError(undefined);
        onSearchChange({ ...search, runValueKey: key, runValue: value });
      }}
    >
      <LabelledField id={`${id}-key`} label="Run value key">
        {(control) => (
          <Input
            {...control}
            value={key}
            maxLength={50}
            onChange={(event) => {
              setKey(event.currentTarget.value);
            }}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-value`}
        label="Exact value"
        description="Case and spaces must match. An empty value is allowed."
      >
        {(control) => (
          <Input
            {...control}
            value={value}
            maxLength={255}
            onChange={(event) => {
              setValue(event.currentTarget.value);
            }}
          />
        )}
      </LabelledField>
      <Button type="submit" variant="outline" className="shrink-0">
        Apply value filter
      </Button>
      {error === undefined ? null : <Notice tone="destructive">{error}</Notice>}
    </form>
  );
}
