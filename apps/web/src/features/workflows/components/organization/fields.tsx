import { useId, useState } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowOrganizationProjectionResponse,
  WorkflowFolder,
  WorkflowTag,
} from '@pertexo/contracts';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { canEditOrganization, type OrganizationOperation } from './editing';
import { WorkflowFolderPicker } from './folders/picker';
import { ADMINISTRATORS } from '@/features/workspaces/roles.public';

type OrganizationFieldsProps = Readonly<{
  workspace: AccessibleWorkspace;
  workflows: readonly WorkflowOrganizationProjectionResponse[];
  folders: readonly WorkflowFolder[];
  tags: readonly WorkflowTag[];
  pending: boolean;
  locked: boolean;
  onConfirm: (
    operation: OrganizationOperation,
    folderId: string | null,
    tagIds: readonly string[],
  ) => Promise<void>;
}>;

export function OrganizationFields({
  workspace,
  workflows,
  folders,
  tags,
  pending,
  locked,
  onConfirm,
}: OrganizationFieldsProps) {
  const id = useId();
  const [operation, setOperation] = useState<OrganizationOperation>('move');
  const [folderId, setFolderId] = useState<string | null>(() =>
    workflows.length === 1
      ? (workflows[0]?.organization.folderId ?? null)
      : null,
  );
  const [tagIds, setTagIds] = useState<readonly string[]>(() =>
    workflows.length === 1
      ? (workflows[0]?.organization.tags.map((tag) => tag.id) ?? [])
      : [],
  );
  const selectedTagIds = new Set(tagIds);
  const validation = useFieldValidation<'tags'>();
  const allowed = canEditOrganization(workspace, workflows, operation);
  const visibleTags = [
    ...new Map(
      [
        ...workflows.flatMap(({ organization }) => organization.tags),
        ...tags,
      ].map((tag) => [tag.id, tag]),
    ).values(),
  ];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || !allowed) return;
        if (
          !validation.submit({
            tags: tagIds.length > 16 ? 'Select at most 16 tags.' : undefined,
          })
        )
          return;
        void onConfirm(operation, folderId, tagIds);
      }}
    >
      <FieldGroup>
        <LabelledField id={`${id}-operation`} label="Change">
          {(control) => (
            <ToggleGroup
              {...control}
              aria-label="Change"
              value={[operation]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === 'move' || next === 'replace_tags')
                  setOperation(next);
              }}
              disabled={locked}
            >
              <ToggleGroupItem value="move">Move to folder</ToggleGroupItem>
              <ToggleGroupItem value="replace_tags">
                Replace tags
              </ToggleGroupItem>
            </ToggleGroup>
          )}
        </LabelledField>
        {operation === 'move' ? (
          <WorkflowFolderPicker
            folders={folders}
            value={folderId}
            onChange={setFolderId}
            disabled={locked || !allowed}
          />
        ) : (
          <fieldset
            disabled={locked || !allowed}
            className="flex flex-col gap-2"
          >
            <legend className="text-sm font-medium">Replacement tags</legend>
            <p className="text-xs text-muted-foreground">
              This replaces all current tags on each selected workflow. Select
              none to clear them. Maximum 16.
            </p>
            {visibleTags.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No workspace tags are available.
              </p>
            ) : (
              visibleTags.map((tag) => {
                const tagSelectionBlocked =
                  locked ||
                  !allowed ||
                  (!selectedTagIds.has(tag.id) && tagIds.length >= 16);
                return (
                  <label
                    key={tag.id}
                    className="flex min-w-0 items-center gap-2 text-sm break-words [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]"
                  >
                    <Checkbox
                      checked={selectedTagIds.has(tag.id)}
                      disabled={tagSelectionBlocked}
                      onCheckedChange={(checked) => {
                        setTagIds((current) =>
                          checked
                            ? [...current, tag.id].sort()
                            : current.filter((id) => id !== tag.id),
                        );
                      }}
                    />
                    {tag.key}
                  </label>
                );
              })
            )}
            {validation.error('tags') === undefined ? null : (
              <Notice tone="destructive">{validation.error('tags')}</Notice>
            )}
          </fieldset>
        )}
        {!allowed ? (
          <Notice>
            {operation === 'replace_tags'
              ? 'Tag replacement requires an editor and active workflows. Archived tags are detached only through admin cleanup.'
              : `Moving active workflows requires an editor. Only ${ADMINISTRATORS} may move archived workflows.`}
          </Notice>
        ) : null}
        <ProgressButton
          type="submit"
          pending={pending}
          pendingLabel="Confirming…"
          disabled={locked || !allowed}
        >
          {operation === 'move'
            ? 'Move selected workflows'
            : 'Replace selected tags'}
        </ProgressButton>
      </FieldGroup>
    </form>
  );
}
