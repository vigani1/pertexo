import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import type { DestinationMutationScope } from '../data/failure-notifications.mutations';
import { useAlertMembers } from '../hooks/use-alert-members';
import type { DestinationField } from '../model/destination-copy';

export function SystemMailFields({
  scope,
  id,
  disabled,
  memberId,
  validation,
  onChange,
}: Readonly<{
  scope: DestinationMutationScope;
  id: string;
  disabled: boolean;
  memberId: string;
  validation: FieldValidation<DestinationField>;
  onChange(memberId: string): void;
}>) {
  const { query, members } = useAlertMembers(scope, true);
  const options = members.map((member) => ({
    value: member.userId,
    label: `${member.displayName} · ${member.email}`,
  }));
  return (
    <>
      <LabelledField
        id={`${id}-member`}
        label="Workspace member"
        error={validation.error('target')}
        description="Alerts use this member's current verified account address. A member who leaves stops receiving. Personal email preferences do not affect shared alerts."
      >
        {(control) => (
          <Select
            value={memberId || null}
            disabled={disabled || query.isPending}
            items={options}
            onValueChange={(value: string | null) => {
              onChange(value ?? '');
              validation.change(
                'target',
                value === null ? 'Choose a workspace member.' : undefined,
              );
            }}
          >
            <SelectTrigger {...control} ref={validation.register('target')}>
              <SelectValue
                placeholder={
                  query.isPending ? 'Loading members…' : 'Choose a member'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {query.isError ? (
        <Notice
          tone="destructive"
          action={
            <Button
              type="button"
              onClick={() => {
                void query.refetch();
              }}
            >
              Retry
            </Button>
          }
        >
          Members could not be loaded. Your choice is kept.
        </Notice>
      ) : null}
      {query.hasNextPage ? (
        <Button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          Load more members
        </Button>
      ) : null}
    </>
  );
}
