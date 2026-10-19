import { useDeferredValue, useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { COLLABORATION_LIMITS } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { peopleQuery } from '../data/collaboration.queries';
import type { CollaborationScope } from '../data/collaboration.api';
export type MentionPerson = Readonly<{ userId: string; displayName: string }>;
export function MentionPicker({
  scope,
  selected,
  onChange,
  disabled,
  typed,
  onPicked,
}: {
  scope: CollaborationScope;
  selected: readonly MentionPerson[];
  onChange: (people: MentionPerson[]) => void;
  disabled: boolean;
  /** The name typed after "@" in the comment, which opens the list. */
  typed?: string | undefined;
  onPicked?: ((person: MentionPerson) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inline = typed !== undefined;
  const shown = open || inline;
  const deferred = useDeferredValue(inline ? typed : search);
  const id = useId();
  const people = useInfiniteQuery({
    ...peopleQuery(scope, deferred),
    enabled: shown,
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen(!open);
          }}
        >
          @ Mention
        </Button>
        {selected.map((person) => (
          <Button
            key={person.userId}
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={'Remove mention of ' + person.displayName}
            onClick={() => {
              onChange(
                selected.filter((item) => item.userId !== person.userId),
              );
            }}
          >
            @{person.displayName} ×
          </Button>
        ))}
      </div>
      {shown ? (
        <div id={id} className="space-y-2 rounded-md border border-border p-3">
          {inline ? null : (
            <>
              <label className="block text-sm" htmlFor={id + '-search'}>
                Find a member
              </label>
              <Input
                id={id + '-search'}
                maxLength={100}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                disabled={disabled}
              />
            </>
          )}
          {people.isError ? (
            <p role="alert" className="text-sm">
              Members could not be loaded. Try again.
            </p>
          ) : null}
          <ul
            aria-label="Members to mention"
            className="max-h-48 overflow-y-auto"
          >
            {people.data?.pages
              .flatMap((page) => page.items)
              .map((person) => (
                <li key={person.userId}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={
                      disabled ||
                      selected.length >= COLLABORATION_LIMITS.mentions ||
                      selected.some((item) => item.userId === person.userId)
                    }
                    onClick={() => {
                      const picked = {
                        userId: person.userId,
                        displayName: person.displayName,
                      };
                      onChange([...selected, picked]);
                      onPicked?.(picked);
                      setOpen(false);
                    }}
                  >
                    {' '}
                    {person.displayName}
                  </Button>
                </li>
              ))}
          </ul>
          {people.hasNextPage ? (
            <Button
              type="button"
              variant="ghost"
              disabled={people.isFetchingNextPage}
              onClick={() => void people.fetchNextPage()}
            >
              More members
            </Button>
          ) : null}
          {selected.length >= COLLABORATION_LIMITS.mentions ? (
            <p className="text-sm">Mention up to twenty people.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
