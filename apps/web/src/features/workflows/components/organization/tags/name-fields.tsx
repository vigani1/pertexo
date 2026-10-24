import type { WorkflowTag } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ProgressButton } from '@/components/ui/progress-button';
import type { useFieldValidation } from '@/components/ui/use-field-validation';
import type { useWorkflowOrganizationCommand } from '../../../hooks/use-workflow-organization-command';
import type { WorkflowOrganizationAttempt } from '../../../model/organization/requests';
const TAG_HINT = 'Lowercase letters, numbers and hyphens, like eu-region.';
export function TagNameActions({
  current,
  disabled,
  command,
  pendingKind,
  onCleanup,
  onCancel,
  onDelete,
}: Readonly<{
  current: WorkflowTag | undefined;
  disabled: boolean;
  command: ReturnType<typeof useWorkflowOrganizationCommand>;
  pendingKind: WorkflowOrganizationAttempt['kind'] | undefined;
  onCleanup: (tag: WorkflowTag) => void;
  onCancel: () => void;
  onDelete: () => void;
}>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProgressButton
        type="submit"
        variant="primary"
        disabled={disabled}
        pending={
          command.pending &&
          (pendingKind === 'create-tag' || pendingKind === 'rename-tag')
        }
        pendingLabel="Saving…"
      >
        {current === undefined ? 'Add tag' : 'Save name'}
      </ProgressButton>
      {current === undefined ? null : (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              onCleanup(current);
            }}
          >
            See workflows using it
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            disabled={disabled}
            onClick={() => {
              onDelete();
            }}
          >
            Delete tag
          </Button>
        </>
      )}
    </div>
  );
}

export function TagNameField({
  id,
  current,
  name,
  disabled,
  fields,
  onChange,
}: Readonly<{
  id: string;
  current: WorkflowTag | undefined;
  name: string;
  disabled: boolean;
  fields: ReturnType<typeof useFieldValidation<'name'>>;
  onChange: (value: string) => void;
}>) {
  return (
    <LabelledField
      id={id}
      label={current === undefined ? 'New tag' : `Rename #${current.key}`}
      error={fields.error('name')}
      description={TAG_HINT}
    >
      {(control) => (
        <Input
          {...control}
          ref={fields.register('name')}
          name="tag-key"
          autoComplete="off"
          spellCheck={false}
          value={name}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </LabelledField>
  );
}
