import { useId, useState } from 'react';
import { ChevronDownIcon, TagIcon } from 'lucide-react';
import { runValueKeySchema, runValueTextSchema } from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { withoutRunFilter, type RunSearch } from '../../model/list/run-search';

/**
 * Find runs by a value a Save run values step stored, beside the other
 * filters. Both parts must match exactly, so the search waits for Apply.
 */
export function BusinessValueFilter({
  search,
  onSearchChange,
}: Readonly<{
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
}>) {
  const [open, setOpen] = useState(false);
  const applied = search.runValueKey;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="col-span-2 w-full justify-start font-normal text-foreground sm:col-span-1 sm:w-auto"
            aria-label={
              applied === undefined
                ? 'Run value: any'
                : `Run value: ${applied} is ${search.runValue ?? ''}`
            }
          />
        }
      >
        <TagIcon aria-hidden="true" />
        <span className="max-w-48 truncate">
          {applied === undefined ? 'Any run value' : `${applied} = …`}
        </span>
        <ChevronDownIcon aria-hidden="true" className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))]">
        <PopoverTitle>Find runs by a saved value</PopoverTitle>
        <ExactValueFields
          key={JSON.stringify([search.runValueKey, search.runValue])}
          search={search}
          onApply={(next) => {
            onSearchChange(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function ExactValueFields({
  search,
  onApply,
}: Readonly<{
  search: RunSearch;
  onApply: (search: RunSearch) => void;
}>) {
  const id = useId();
  const [key, setKey] = useState(search.runValueKey ?? '');
  const [value, setValue] = useState(search.runValue ?? '');
  const [errors, setErrors] = useState<
    Readonly<{ key?: string; value?: string }>
  >({});
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const next = {
          ...(runValueKeySchema.safeParse(key).success
            ? {}
            : {
                key: 'Use the name the step saved: letters, numbers, dots, hyphens or underscores, up to 50.',
              }),
          ...(runValueTextSchema.safeParse(value).success
            ? {}
            : { value: 'Use a value up to 255 characters.' }),
        };
        setErrors(next);
        if (next.key === undefined && next.value === undefined)
          onApply({ ...search, runValueKey: key, runValue: value });
      }}
    >
      <LabelledField id={`${id}-key`} label="Name" error={errors.key}>
        {(control) => (
          <Input
            {...control}
            placeholder="orderId"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
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
        label="Value"
        description="Matches exactly, including capitals and spaces."
        error={errors.value}
      >
        {(control) => (
          <Input
            {...control}
            placeholder="A-1042"
            autoComplete="off"
            className="font-mono"
            value={value}
            maxLength={255}
            onChange={(event) => {
              setValue(event.currentTarget.value);
            }}
          />
        )}
      </LabelledField>
      <div className="flex items-center justify-end gap-2">
        {search.runValueKey === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onApply(withoutRunFilter(search, 'runValueKey'));
            }}
          >
            Clear
          </Button>
        )}
        <Button type="submit" variant="primary">
          Find runs
        </Button>
      </div>
    </form>
  );
}
