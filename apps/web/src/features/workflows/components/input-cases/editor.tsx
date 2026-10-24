import { CaseExpectations } from './expectations';
import { expectationDraft } from '../../model/input-cases/expectations';
import { useId, useState } from 'react';
import {
  workflowInputCaseCreateRequestSchema,
  workflowInputCaseUpdateRequestSchema,
  type WorkflowSummary,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import type { useInputCases } from '../../hooks/use-input-cases';
import type { InputCaseCommand } from '../../data/input-cases/api';

type CaseCommands = Pick<
  ReturnType<typeof useInputCases>,
  | 'scope'
  | 'selected'
  | 'pending'
  | 'uncertain'
  | 'conflict'
  | 'read'
  | 'send'
  | 'retry'
>;

/** A local draft survives revision conflicts and current-case reads. */
type InputCaseEditorProps = Readonly<{
  cases: CaseCommands;
  workflow: WorkflowSummary;
  locked: boolean;
  writable: boolean;
  onClose: () => void;
}>;

export function InputCaseEditor(props: InputCaseEditorProps) {
  const model = useInputCaseForm(props);
  const fieldsDisabled = model.locked || model.deleting || !model.writable;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {model.cases.selected === undefined
          ? 'New case for the current published version.'
          : 'Editing does not change the case’s published version.'}
        {model.cases.selected === undefined &&
        model.creatingVersionId !== undefined ? (
          <span className="block break-all font-mono">
            Bound version: {model.creatingVersionId}
          </span>
        ) : null}
      </p>
      <FieldGroup>
        <LabelledField
          id={`${model.id}-name`}
          label="Case name"
          error={model.validation.error('name')}
        >
          {(control) => {
            return (
              <Input
                {...control}
                ref={model.validation.register('name')}
                name="case-name"
                autoComplete="off"
                value={model.name}
                disabled={fieldsDisabled}
                maxLength={128}
                onChange={(event) => {
                  model.setName(event.target.value);
                  model.validation.change(
                    'name',
                    event.target.value.trim()
                      ? undefined
                      : 'Enter a case name.',
                  );
                }}
              />
            );
          }}
        </LabelledField>
        <LabelledField
          id={`${model.id}-input`}
          label="Case input (JSON)"
          error={model.validation.error('input')}
        >
          {(control) => (
            <Textarea
              {...control}
              ref={model.validation.register('input')}
              name="case-input"
              value={model.input}
              disabled={fieldsDisabled}
              autoComplete="off"
              spellCheck={false}
              className="min-h-32 font-mono"
              onChange={(event) => {
                model.setInput(event.target.value);
                let problem: string | undefined;
                try {
                  JSON.parse(event.target.value);
                } catch {
                  problem = 'Enter valid JSON.';
                }
                model.validation.change('input', problem);
              }}
            />
          )}
        </LabelledField>
      </FieldGroup>
      <CaseExpectations
        value={model.expectations}
        onChange={model.setExpectations}
        scope={model.cases.scope}
        disabled={fieldsDisabled}
        error={model.expectationError}
      />
      {model.cases.conflict && model.cases.selected !== undefined ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void model.cases.read(model.cases.selected?.id ?? '')}
        >
          Read current case; keep my edits
        </Button>
      ) : null}
      <InputCaseActions
        cases={model.cases}
        locked={model.locked}
        deleting={model.deleting}
        onDeletingChange={model.setDeleting}
        onClose={model.onClose}
        onSave={() => void model.save()}
      />
    </>
  );
}

function useInputCaseForm({
  cases,
  workflow,
  locked,
  writable,
  onClose,
}: InputCaseEditorProps) {
  const [name, setName] = useState(cases.selected?.name ?? '');
  const [input, setInput] = useState(() =>
    JSON.stringify(cases.selected?.input ?? {}, null, 2),
  );
  const [expectations, setExpectations] = useState(() =>
    expectationDraft(cases.selected?.expectations),
  );
  const [expectationError, setExpectationError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [creatingVersionId] = useState(
    workflow.publishedVersionId ?? undefined,
  );
  const validation = useFieldValidation<'name' | 'input'>();
  const notifications = useNotifications();
  const id = useId();
  async function save() {
    const caseEditingBlocked =
      locked || deleting || !writable || cases.conflict;
    if (caseEditingBlocked) return;
    let value: unknown;
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      value = undefined;
    }
    let parsedExpectations: unknown;
    try {
      parsedExpectations = {
        outcome: expectations.outcome,
        assertions: expectations.assertions.map((item) => ({
          source:
            item.source === ''
              ? { kind: 'final' }
              : { kind: 'step', nodeId: item.source },
          path: item.path,
          operator: item.operator,
          expected: JSON.parse(item.expected) as unknown,
        })),
      };
    } catch {
      setExpectationError('Enter valid JSON for each expected value.');
      return;
    }
    setExpectationError(undefined);
    const body = workflowInputCaseUpdateRequestSchema.safeParse({
      name,
      input: value,
      expectations: parsedExpectations,
    });
    const errors = {
      name: undefined as string | undefined,
      input: undefined as string | undefined,
    };
    if (!body.success)
      for (const issue of body.error.issues) {
        if (issue.path[0] === 'name') errors.name = issue.message;
        else if (issue.path[0] === 'expectations')
          setExpectationError(issue.message);
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
    if (await cases.send({ command })) {
      onClose();
      notifications.success({ title: 'Input case saved' });
    }
  }

  return {
    cases,
    creatingVersionId,
    id,
    validation,
    name,
    locked,
    deleting,
    writable,
    setName,
    input,
    setInput,
    expectations,
    setExpectations,
    expectationError,
    setDeleting,
    onClose,
    save,
  } as const;
}

function InputCaseActions({
  cases,
  locked,
  deleting,
  onDeletingChange,
  onClose,
  onSave,
}: Readonly<{
  cases: CaseCommands;
  locked: boolean;
  deleting: boolean;
  onDeletingChange: (deleting: boolean) => void;
  onClose: () => void;
  onSave: () => void;
}>) {
  const notifications = useNotifications();
  return (
    <>
      {deleting ? (
        <Notice tone="warning">
          Delete this shared case? It will no longer be loadable. Input already
          loaded into a run stays unchanged. Held data may remain until
          retention allows erasure.
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={locked}
          onClick={() => {
            onClose();
            onDeletingChange(false);
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
                  onClose();
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
                    onDeletingChange(true);
                    return;
                  }
                  const record = cases.selected;
                  if (record !== undefined)
                    void cases
                      .send({
                        command: {
                          kind: 'delete',
                          caseId: record.id,
                          tag: record.representationTag,
                          key: crypto.randomUUID(),
                        },
                      })
                      .then((ok) => {
                        if (ok) {
                          onClose();
                          onDeletingChange(false);
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
                onClick={onSave}
              >
                Save input case
              </ProgressButton>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
