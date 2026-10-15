import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { TaskAudience } from '@pertexo/workflow-model';
import {
  audienceQueryOptions,
  type TaskScope,
} from '@/features/pending-tasks/queries.public';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { LoadMore } from '@/components/patterns/load-more';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import type { NodeFormApi } from '../../../model/inspector/node-form';
const roles = ['owner', 'admin', 'builder', 'operator', 'viewer'] as const;
export function AudienceField({
  scope,
  form,
  audience,
  onChange,
}: Readonly<{
  scope: TaskScope;
  form: NodeFormApi;
  audience: TaskAudience;
  onChange: (next: TaskAudience) => void;
}>) {
  const [search, setSearch] = useState('');
  const members = useInfiniteQuery({
    ...audienceQueryOptions(scope, search),
    enabled: form.editable,
  });
  const visible = members.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedIds = new Set(audience.memberIds);
  const names = new Map(
    visible.map((member) => [member.userId, member.displayName]),
  );
  return (
    <fieldset className="flex flex-col gap-3" disabled={!form.editable}>
      <legend className="mb-2 text-sm font-medium">Who can decide</legend>
      <p className="text-xs text-muted-foreground">
        Choose roles, named members, or both. At least one must remain. Current
        membership is checked when deciding.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {roles.map((role) => (
          <label key={role} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={audience.roles.includes(role)}
              onCheckedChange={(checked) => {
                onChange({
                  ...audience,
                  roles: checked
                    ? [...audience.roles, role]
                    : audience.roles.filter((item) => item !== role),
                });
              }}
            />
            {role}
          </label>
        ))}
      </div>
      <Field>
        <FieldLabel htmlFor={`${form.nodeId}-audience-search`}>
          Find a named member
        </FieldLabel>
        <Input
          id={`${form.nodeId}-audience-search`}
          value={search}
          maxLength={100}
          placeholder="Search members by name"
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <FieldDescription>
          Up to 50 named members. Removed members must be replaced before
          publishing.
        </FieldDescription>
      </Field>
      {members.isError ? (
        <ReadFailure
          resource="Members"
          error={members.error}
          showing={members.data !== undefined}
          retrying={members.isFetching}
          updatedAt={members.dataUpdatedAt}
          onRetry={() => void members.refetch()}
        />
      ) : null}
      <ul className="flex max-h-48 flex-col gap-3 overflow-y-auto">
        {visible.map((member) => (
          <li key={member.userId}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedIds.has(member.userId)}
                disabled={
                  !selectedIds.has(member.userId) &&
                  audience.memberIds.length >= 50
                }
                onCheckedChange={(checked) => {
                  onChange({
                    ...audience,
                    memberIds: checked
                      ? [...audience.memberIds, member.userId]
                      : audience.memberIds.filter((id) => id !== member.userId),
                  });
                }}
              />
              <span>
                {member.displayName}{' '}
                <span className="text-muted-foreground">({member.role})</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <LoadMore
        subject="members"
        hasNextPage={members.hasNextPage}
        loading={members.isFetchingNextPage}
        failed={members.isFetchNextPageError}
        onLoadMore={() => void members.fetchNextPage()}
      />
      {audience.memberIds.length === 0 ? null : (
        <ul className="flex flex-col gap-2" aria-label="Selected members">
          {audience.memberIds.map((id) => (
            <li
              key={id}
              className="flex items-start justify-between gap-2 text-xs"
            >
              <span className="break-all">{names.get(id) ?? id}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  onChange({
                    ...audience,
                    memberIds: audience.memberIds.filter(
                      (value) => value !== id,
                    ),
                  });
                }}
                aria-label={`Remove ${names.get(id) ?? id} from audience`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
