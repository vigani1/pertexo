import { useEffect, useEffectEvent, useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { WorkflowInputCase, WorkflowSummary } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import type { useInputCases } from '../../hooks/use-input-cases';
import { InputCaseEditor } from './editor';

export type LoadedInputCase = Readonly<{
  name: string;
  workflowVersionId: string;
  input: unknown;
}>;

/** The single shared case browser/editor, never an execution command. */
export function InputCasesPanel({
  cases,
  workspace,
  workflow,
  disabled = false,
  editing: controlledEditing,
  onLoad,
  onEditingChange,
  onAccessLost,
}: Readonly<{
  cases: ReturnType<typeof useInputCases>;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  disabled?: boolean;
  /** The run dialog owns editing alongside its confirmation guard. */
  editing?: boolean;
  onLoad: (input: LoadedInputCase) => void;
  onEditingChange?: (editing: boolean) => void;
  onAccessLost?: () => void;
}>) {
  const writable =
    workspace.status === 'active' &&
    workflow.lifecycleStatus === 'active' &&
    workspace.capabilities.includes('workflow:update');
  const [localEditing, setLocalEditing] = useState(false);
  const editing = controlledEditing ?? localEditing;
  function changeEditing(next: boolean) {
    if (controlledEditing === undefined) setLocalEditing(next);
    onEditingChange?.(next);
  }
  const releaseEditing = useEffectEvent(() => onEditingChange?.(false));
  const locked = disabled || cases.pending || cases.uncertain;
  // Releasing an unmounted case browser clears its parent's command guard.
  // Live editing changes come from their events, in the same React update.
  useEffect(() => () => releaseEditing(), []);
  useEffect(() => {
    if (cases.accessLost) onAccessLost?.();
  }, [cases.accessLost, onAccessLost]);
  if (cases.accessLost)
    return (
      <Notice tone="warning">
        Access to input cases is no longer available.
      </Notice>
    );

  function edit(record?: WorkflowInputCase) {
    if (record === undefined) cases.clearSelection();
    changeEditing(true);
  }

  function load(record: WorkflowInputCase) {
    onLoad({
      name: record.name,
      workflowVersionId: record.workflowVersionId,
      input: structuredClone(record.input),
    });
  }

  return (
    <section aria-label="Input cases" className="flex flex-col gap-3">
      <InputCaseToolbar
        cases={cases}
        workflow={workflow}
        writable={writable}
        editing={editing}
        locked={locked}
        onCreate={() => {
          edit();
        }}
      />
      <InputCaseList
        query={cases.query}
        publishedVersionId={workflow.publishedVersionId}
        writable={writable}
        locked={locked || editing}
        onLoad={(caseId) =>
          void cases.read(caseId).then((value) => {
            if (value !== undefined) load(value);
          })
        }
        onEdit={(caseId) =>
          void cases.read(caseId).then((value) => {
            if (value !== undefined) edit(value);
          })
        }
      />
      {editing ? (
        <InputCaseEditor
          cases={cases}
          workflow={workflow}
          locked={locked}
          writable={writable}
          onClose={() => {
            changeEditing(false);
          }}
        />
      ) : null}
      {cases.error === undefined ? null : (
        <Notice
          tone={cases.uncertain || cases.conflict ? 'warning' : 'destructive'}
        >
          {cases.error}
        </Notice>
      )}
    </section>
  );
}

function InputCaseToolbar({
  cases,
  workflow,
  writable,
  editing,
  locked,
  onCreate,
}: Readonly<{
  cases: ReturnType<typeof useInputCases>;
  workflow: WorkflowSummary;
  writable: boolean;
  editing: boolean;
  locked: boolean;
  onCreate: () => void;
}>) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-sm">Input cases</h3>
        {writable &&
        cases.query.isSuccess &&
        !editing &&
        workflow.publishedVersionId !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={onCreate}
          >
            New input case
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Shared synthetic JSON tied to a published version. Loading never runs
        anything. Don’t save secrets or personal data: inputs are not
        automatically redacted.
      </p>
    </>
  );
}

type CaseListProps = Readonly<{
  query: ReturnType<typeof useInputCases>['query'];
  publishedVersionId: string | null;
  writable: boolean;
  locked: boolean;
  onLoad: (caseId: string) => void;
  onEdit: (caseId: string) => void;
}>;

function InputCaseList({
  query,
  publishedVersionId,
  writable,
  locked,
  onLoad,
  onEdit,
}: CaseListProps) {
  return (
    <>
      {query.isPending ? <Skeleton className="h-12 w-full" /> : null}
      {query.error ? (
        <ReadFailure
          resource="Input cases"
          error={query.error}
          updatedAt={query.dataUpdatedAt}
          showing={query.data !== undefined}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data?.pages
        .flatMap((page) => page.items)
        .map((record) => (
          <InputCaseRow
            key={record.id}
            record={record}
            publishedVersionId={publishedVersionId}
            writable={writable}
            locked={locked}
            onLoad={onLoad}
            onEdit={onEdit}
          />
        ))}
      {query.data?.pages[0]?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No input cases yet.{' '}
          {writable
            ? 'Create one from synthetic JSON after publishing.'
            : 'A workflow editor can create a shared case.'}
        </p>
      ) : null}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          disabled={locked || query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more input cases
        </Button>
      ) : null}
    </>
  );
}

function InputCaseRow({
  record,
  publishedVersionId,
  writable,
  locked,
  onLoad,
  onEdit,
}: Omit<CaseListProps, 'query'> &
  Readonly<{
    record: Omit<WorkflowInputCase, 'input'>;
  }>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm">{record.name}</p>
        <p className="text-xs text-muted-foreground">
          {record.workflowVersionId === publishedVersionId
            ? 'Current published version'
            : 'Historical version — review before starting'}
        </p>
      </div>
      <div className="flex max-w-full flex-wrap gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-auto min-h-7 max-w-full py-1.5 whitespace-normal wrap-anywhere pointer-coarse:h-auto pointer-coarse:min-h-10"
          disabled={locked}
          onClick={() => {
            onLoad(record.id);
          }}
        >
          Load {record.name}
        </Button>
        {writable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto min-h-7 max-w-full py-1.5 whitespace-normal wrap-anywhere pointer-coarse:h-auto pointer-coarse:min-h-10"
            disabled={locked}
            onClick={() => {
              onEdit(record.id);
            }}
          >
            Edit {record.name}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
