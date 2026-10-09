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
import { ProgressButton } from '@/components/ui/progress-button';
import { LoadMore } from '@/components/patterns/load-more';
import { workflowTagAssignmentsInfiniteQueryOptions } from '../../data/organization.queries';
import type { WorkflowOrganizationAttempt } from '../../model/organization/requests';
import {
  OrganizationCommandFeedback,
  type OrganizationCommand,
} from './organization-command-feedback';
import { useOrganizationWorkflowNames } from './use-organization-workflow-names';

export function WorkflowTagCleanup({
  apiClient,
  userId,
  workspaceId,
  tag,
  locked,
  command,
  start,
  onBack,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  tag: WorkflowTag;
  locked: boolean;
  command: OrganizationCommand;
  start: (attempt: WorkflowOrganizationAttempt) => void;
  onBack: () => void;
}>) {
  const assignments = useInfiniteQuery(
    workflowTagAssignmentsInfiniteQueryOptions(
      apiClient,
      userId,
      workspaceId,
      tag.id,
      { limit: 25 },
    ),
  );
  const [selection, setSelection] = useState<WorkflowOrganizationBulkItem[]>(
    [],
  );
  const id = useId();
  const rows = assignments.data?.pages.flatMap((page) => page.items) ?? [];
  const names = useOrganizationWorkflowNames(
    apiClient,
    userId,
    workspaceId,
    [
      ...selection.map((item) => item.workflowId),
      ...rows.map((row) => row.workflowId),
    ],
    command.denied,
  );
  const settled = command.result !== undefined;
  const disabled =
    locked || settled || !assignments.isSuccess || assignments.isFetching;
  return (
    <section aria-label="Tag cleanup" className="flex flex-col gap-4">
      <h2 className="font-display text-lg">Clean up {tag.key}</h2>
      <p>
        Choose up to 50 workflows from the loaded pages, including archived
        assignments. There is no select-all. Selection order is the order you
        check them.
      </p>
      <OrganizationCommandFeedback command={command} names={names} />
      {assignments.isError ? (
        <Notice tone="destructive">
          Assignments could not be loaded. Reload before choosing workflows.
        </Notice>
      ) : null}
      <fieldset disabled={disabled} className="flex flex-col gap-4">
        <legend className="text-sm">
          Workflows with this tag ({selection.length}/50 selected)
        </legend>
        <FieldGroup>
          {rows.map((row, index) => {
            const checked = selection.some(
              (item) => item.workflowId === row.workflowId,
            );
            return (
              <LabelledField
                key={row.workflowId}
                id={`${id}-${row.workflowId}`}
                label={`Select ${names.get(row.workflowId) ?? `workflow name unavailable (${String(index + 1)})`}`}
              >
                {(control) => (
                  <Checkbox
                    {...control}
                    checked={checked}
                    disabled={disabled || (!checked && selection.length >= 50)}
                    onCheckedChange={(next) => {
                      setSelection((previous) =>
                        next
                          ? previous.length >= 50 ||
                            previous.some(
                              (item) => item.workflowId === row.workflowId,
                            )
                            ? previous
                            : [
                                ...previous,
                                {
                                  workflowId: row.workflowId,
                                  expectedOrganizationRevision:
                                    row.organizationRevision,
                                },
                              ]
                          : previous.filter(
                              (item) => item.workflowId !== row.workflowId,
                            ),
                      );
                    }}
                  />
                )}
              </LabelledField>
            );
          })}
        </FieldGroup>
      </fieldset>
      {assignments.isSuccess && rows.length === 0 ? (
        <Notice>
          No loaded assignments remain. Return to tags and explicitly confirm
          deletion with its current revision.
        </Notice>
      ) : null}
      <LoadMore
        subject="tag assignments"
        hasNextPage={assignments.hasNextPage}
        loading={assignments.isFetchingNextPage || locked || settled}
        failed={assignments.isFetchNextPageError}
        label="Load more assignments"
        onLoadMore={() => {
          if (!locked && !settled) void assignments.fetchNextPage();
        }}
      />
      <ProgressButton
        type="button"
        variant="destructive"
        disabled={disabled || selection.length === 0}
        pending={command.pending}
        pendingLabel="Detaching…"
        onClick={() => {
          start({
            kind: 'tag-cleanup',
            workspaceId,
            idempotencyKey: crypto.randomUUID(),
            body: { tagId: tag.id, items: selection },
          });
        }}
      >
        Detach tag from {selection.length} selected workflows
      </ProgressButton>
      <Button
        type="button"
        variant="outline"
        disabled={locked || assignments.isFetching}
        onClick={() => {
          command.reset();
          setSelection([]);
          void assignments.refetch();
        }}
      >
        Reload assignments and clear selection
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={locked}
        onClick={onBack}
      >
        Back to tags
      </Button>
    </section>
  );
}
