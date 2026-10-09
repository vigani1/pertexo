import { useEffect, useId, useState } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  workflowInputCaseCreateRequestSchema,
  workflowInputCaseUpdateRequestSchema,
  type WorkflowInputCase,
  type WorkflowSummary,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import type { ApiClient } from '@/lib/api/client';
import { useInputCases } from '../../hooks/use-input-cases';
import type { InputCaseCommand } from '../../data/input-cases.api';

export type LoadedInputCase = Readonly<{
  name: string;
  workflowVersionId: string;
  input: unknown;
}>;

/** The single shared case browser/editor, never an execution command. */
export function InputCasesPanel({
  apiClient,
  userId,
  workspace,
  workflow,
  disabled = false,
  onLoad,
  onLockedChange,
  onEditingChange,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  disabled?: boolean;
  onLoad: (input: LoadedInputCase) => void;
  onLockedChange?: (locked: boolean) => void;
  onEditingChange?: (editing: boolean) => void;
  onAccessLost?: () => void;
}>) {
  const writable =
    workspace.status === 'active' &&
    workflow.lifecycleStatus === 'active' &&
    workspace.capabilities.includes('workflow:update');
  const cases = useInputCases(
    apiClient,
    userId,
    workspace.id,
    workflow.id,
    writable,
  );
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [input, setInput] = useState('{}');
  const [deleting, setDeleting] = useState(false);
  const [creatingVersionId, setCreatingVersionId] = useState<string>();
  const validation = useFieldValidation<'name' | 'input'>();
  const notifications = useNotifications();
  const id = useId();
  const locked = disabled || cases.pending || cases.uncertain;
  useEffect(() => {
    onLockedChange?.(cases.pending || cases.uncertain);
    return () => onLockedChange?.(false);
  }, [cases.pending, cases.uncertain, onLockedChange]);
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);
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
    setCreatingVersionId(workflow.publishedVersionId ?? undefined);
    setName(record?.name ?? '');
    setInput(JSON.stringify(record?.input ?? {}, null, 2));
    setEditing(true);
    setDeleting(false);
    validation.reset();
  }

  async function save() {
    let value: unknown;
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      value = undefined;
    }
    const body = workflowInputCaseUpdateRequestSchema.safeParse({
      name,
      input: value,
    });
    const errors = {
      name: undefined as string | undefined,
      input: undefined as string | undefined,
    };
    if (!body.success)
      for (const issue of body.error.issues) {
        if (issue.path[0] === 'name') errors.name = issue.message;
        else errors.input = issue.message;
      }
    if (!validation.submit(errors) || !body.success) return;
    const key = crypto.randomUUID();
    let command: InputCaseCommand;
    if (cases.selected !== undefined)
      command = {
        kind: 'update',
        caseId: cases.selected.id,
        tag: cases.selected.representationTag,
        key,
        body: body.data,
      };
    else {
      if (creatingVersionId === undefined) return;
      command = {
        kind: 'create',
        key,
        body: workflowInputCaseCreateRequestSchema.parse({
          ...body.data,
          workflowVersionId: creatingVersionId,
        }),
      };
    }
    if (await cases.send(command)) {
      setEditing(false);
      notifications.success({ title: 'Input case saved' });
    }
  }

  function load(record: WorkflowInputCase) {
    onLoad({
      name: record.name,
      workflowVersionId: record.workflowVersionId,
      input: JSON.parse(JSON.stringify(record.input)) as unknown,
    });
  }

  return (
    <section aria-label="Input cases" className="flex flex-col gap-3">
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
            onClick={() => {
              edit();
            }}
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
      {cases.query.isPending ? <Skeleton className="h-12 w-full" /> : null}
      {cases.query.error ? (
        <ReadFailure
          resource="Input cases"
          error={cases.query.error}
          updatedAt={cases.query.dataUpdatedAt}
          showing={cases.query.data !== undefined}
          retrying={cases.query.isFetching}
          onRetry={() => void cases.query.refetch()}
        />
      ) : null}
      {cases.query.data?.pages
        .flatMap((page) => page.items)
        .map((record) => (
          <div
            key={record.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{record.name}</p>
              <p className="text-xs text-muted-foreground">
                {record.workflowVersionId === workflow.publishedVersionId
                  ? 'Current published version'
                  : 'Historical version — review before starting'}
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={locked || editing}
                onClick={() =>
                  void cases.read(record.id).then((value) => {
                    if (value !== undefined) load(value);
                  })
                }
              >
                Load {record.name}
              </Button>
              {writable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={locked || editing}
                  onClick={() =>
                    void cases.read(record.id).then((value) => {
                      if (value !== undefined) edit(value);
                    })
                  }
                >
                  Edit {record.name}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      {cases.query.data?.pages[0]?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No input cases yet.{' '}
          {writable
            ? 'Create one from synthetic JSON after publishing.'
            : 'A workflow editor can create a shared case.'}
        </p>
      ) : null}
      {cases.query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          disabled={locked || cases.query.isFetchingNextPage}
          onClick={() => void cases.query.fetchNextPage()}
        >
          Load more input cases
        </Button>
      ) : null}
      {editing ? (
        <>
          <p className="text-xs text-muted-foreground">
            {cases.selected === undefined
              ? 'New case for the current published version.'
              : 'Editing does not change the case’s published version.'}
            {cases.selected === undefined && creatingVersionId !== undefined ? (
              <span className="block break-all font-mono">
                Bound version: {creatingVersionId}
              </span>
            ) : null}
          </p>
          <FieldGroup>
            <LabelledField
              id={`${id}-name`}
              label="Case name"
              error={validation.error('name')}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={validation.register('name')}
                  value={name}
                  disabled={locked || deleting || !writable}
                  maxLength={128}
                  onChange={(event) => {
                    setName(event.target.value);
                    validation.change(
                      'name',
                      event.target.value.trim()
                        ? undefined
                        : 'Enter a case name.',
                    );
                  }}
                />
              )}
            </LabelledField>
            <LabelledField
              id={`${id}-input`}
              label="Case input (JSON)"
              error={validation.error('input')}
            >
              {(control) => (
                <Textarea
                  {...control}
                  ref={validation.register('input')}
                  value={input}
                  disabled={locked || deleting || !writable}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-32 font-mono"
                  onChange={(event) => {
                    setInput(event.target.value);
                    let problem: string | undefined;
                    try {
                      JSON.parse(event.target.value);
                    } catch {
                      problem = 'Enter valid JSON.';
                    }
                    validation.change('input', problem);
                  }}
                />
              )}
            </LabelledField>
          </FieldGroup>
          {cases.conflict && cases.selected !== undefined ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void cases.read(cases.selected?.id ?? '')}
            >
              Read current case; keep my edits
            </Button>
          ) : null}
          {deleting ? (
            <Notice tone="warning">
              Delete this shared case? It will no longer be loadable. Input
              already loaded into a run stays unchanged. Held data may remain
              until retention allows erasure.
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                setEditing(false);
                setDeleting(false);
              }}
            >
              Cancel case edit
            </Button>
            {cases.uncertain ? (
              <ProgressButton
                type="button"
                pending={cases.pending}
                pendingLabel="Retrying case change…"
                onClick={() =>
                  void cases.retry().then((ok) => {
                    if (ok) {
                      setEditing(false);
                      notifications.success({
                        title: 'Input-case change confirmed',
                      });
                    }
                  })
                }
              >
                Retry exact case change
              </ProgressButton>
            ) : (
              <>
                {cases.selected !== undefined ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={locked || cases.conflict}
                    onClick={() => {
                      if (!deleting) {
                        setDeleting(true);
                        return;
                      }
                      const record = cases.selected;
                      if (record !== undefined)
                        void cases
                          .send({
                            kind: 'delete',
                            caseId: record.id,
                            tag: record.representationTag,
                            key: crypto.randomUUID(),
                          })
                          .then((ok) => {
                            if (ok) {
                              setEditing(false);
                              setDeleting(false);
                              notifications.success({
                                title: 'Input case deleted',
                              });
                            }
                          });
                    }}
                  >
                    {deleting ? 'Confirm delete case' : 'Delete case'}
                  </Button>
                ) : null}
                {!deleting ? (
                  <ProgressButton
                    type="button"
                    pending={cases.pending}
                    pendingLabel="Saving case…"
                    disabled={locked || cases.conflict}
                    onClick={() => void save()}
                  >
                    Save input case
                  </ProgressButton>
                ) : null}
              </>
            )}
          </div>
        </>
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
