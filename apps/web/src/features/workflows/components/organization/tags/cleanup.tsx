import { useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type {
  WorkflowTag,
  WorkflowOrganizationBulkItem,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import { ProgressButton } from '@/components/ui/progress-button';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { workflowTagAssignmentsInfiniteQueryOptions } from '../../../data/organization/queries';
import type { WorkflowOrganizationAttempt } from '../../../model/organization/requests';
import {
  OrganizationCommandFeedback,
  type OrganizationCommand,
} from '../command-feedback';
import { useOrganizationWorkflowNames } from '../use-workflow-names';

type WorkflowTagCleanupProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  tag: WorkflowTag;
  locked: boolean;
  command: OrganizationCommand;
  start: (attempt: WorkflowOrganizationAttempt) => void;
  onBack: () => void;
}>;

export function WorkflowTagCleanup(props: WorkflowTagCleanupProps) {
  const model = useTagCleanupSelection(props);
  return (
    <section aria-label="Tag cleanup" className="flex flex-col gap-4">
      <h2 className="font-display text-lg">Clean up {model.tag.key}</h2>
      <p>
        Choose up to 50 workflows from the loaded pages, including archived
        assignments. There is no select-all. Selection order is the order you
        check them.
      </p>
      <OrganizationCommandFeedback
        command={model.command}
        names={model.names}
      />
      <QueryView query={model.assignments} resource="Assignments" />
      <fieldset disabled={model.disabled} className="flex flex-col gap-4">
        <legend className="text-sm">
          Workflows with this tag ({model.selection.length}/50 selected)
        </legend>
        <FieldGroup>
          {model.rows.map((row, index) => {
            const checked = model.selection.some(
              (item) => item.workflowId === row.workflowId,
            );
            return (
              <LabelledField
                key={row.workflowId}
                id={`${model.id}-${row.workflowId}`}
                label={`Select ${model.names.get(row.workflowId) ?? `workflow name unavailable (${String(index + 1)})`}`}
              >
                {(control) => (
                  <Checkbox
                    {...control}
                    checked={checked}
                    disabled={
                      model.disabled ||
                      (!checked && model.selection.length >= 50)
                    }
                    onCheckedChange={(next) => {
                      model.setSelection((previous) => {
                        if (next) {
                          if (
                            previous.length >= 50 ||
                            previous.some(
                              (item) => item.workflowId === row.workflowId,
                            )
                          ) {
                            return previous;
                          }
                          return [
                            ...previous,
                            {
                              workflowId: row.workflowId,
                              expectedOrganizationRevision:
                                row.organizationRevision,
                            },
                          ];
                        }
                        return previous.filter(
                          (item) => item.workflowId !== row.workflowId,
                        );
                      });
                    }}
                  />
                )}
              </LabelledField>
            );
          })}
        </FieldGroup>
      </fieldset>
      {model.assignments.isSuccess && model.rows.length === 0 ? (
        <Notice>
          No loaded assignments remain. Return to tags and explicitly confirm
          deletion with its current revision.
        </Notice>
      ) : null}
      <LoadMore
        subject="tag assignments"
        hasNextPage={model.assignments.hasNextPage}
        loading={
          model.assignments.isFetchingNextPage || model.locked || model.settled
        }
        failed={model.assignments.isFetchNextPageError}
        label="Load more assignments"
        onLoadMore={() => {
          if (!model.locked && !model.settled)
            void model.assignments.fetchNextPage();
        }}
      />
      <ProgressButton
        type="button"
        variant="destructive"
        disabled={model.disabled || model.selection.length === 0}
        pending={model.command.pending}
        pendingLabel="Detaching…"
        onClick={() => {
          model.start({
            kind: 'tag-cleanup',
            workspaceId: model.workspaceId,
            idempotencyKey: crypto.randomUUID(),
            body: { tagId: model.tag.id, items: model.selection },
          });
        }}
      >
        Detach tag from {model.selection.length} selected workflows
      </ProgressButton>
      <Button
        type="button"
        variant="outline"
        disabled={model.locked || model.assignments.isFetching}
        onClick={() => {
          model.command.reset();
          model.setSelection([]);
          void model.assignments.refetch();
        }}
      >
        Reload assignments and clear selection
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={model.locked}
        onClick={model.onBack}
      >
        Back to tags
      </Button>
    </section>
  );
}

function useTagCleanupSelection({
  apiClient,
  userId,
  workspaceId,
  tag,
  locked,
  command,
  start,
  onBack,
}: WorkflowTagCleanupProps) {
  const assignments = useInfiniteQuery(
    workflowTagAssignmentsInfiniteQueryOptions({
      api: apiClient,
      userId,
      workspaceId,
      tagId: tag.id,
      input: { limit: 25 },
    }),
  );
  const [selection, setSelection] = useState<WorkflowOrganizationBulkItem[]>(
    [],
  );
  const id = useId();
  const rows = assignments.data?.pages.flatMap((page) => page.items) ?? [];
  const names = useOrganizationWorkflowNames({
    apiClient,
    userId,
    workspaceId,
    workflowIds: [
      ...selection.map((item) => item.workflowId),
      ...rows.map((row) => row.workflowId),
    ],
    denied: command.denied,
  });
  const settled = command.result !== undefined;
  const disabled =
    locked || settled || !assignments.isSuccess || assignments.isFetching;

  return {
    tag,
    command,
    names,
    assignments,
    disabled,
    selection,
    rows,
    id,
    setSelection,
    locked,
    settled,
    start,
    workspaceId,
    onBack,
  } as const;
}
