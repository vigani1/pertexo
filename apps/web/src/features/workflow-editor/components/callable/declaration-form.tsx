import { useId, useState } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  safeParseWorkflowGraphDraft,
  validateWorkflowGraph,
} from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldGroup } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Separator } from '@/components/ui/separator';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { declaredType, editType } from '../../forms/callable/type-draft';
import { declaredResult, editResult } from '../../forms/callable/result-draft';
import { TypeFields } from './type-fields';
import { ResultFields } from './result-fields';

function initialForm(graph: WorkflowGraphContract) {
  return {
    enabled: graph.callable !== undefined,
    input: editType(
      graph.callable?.input ?? { type: 'object', properties: [] },
    ),
    resultType: editType(
      graph.callable?.resultType ?? { type: 'object', properties: [] },
    ),
    result: editResult(
      graph.callable?.result ?? { kind: 'run_input', path: '$' },
    ),
  };
}

export function DeclarationForm({
  graph,
  editable,
  onChange,
  onApply,
  onClose,
}: Readonly<{
  graph: WorkflowGraphContract;
  editable: boolean;
  onChange: () => void;
  onApply: (graph: WorkflowGraphContract) => void;
  onClose: () => void;
}>) {
  const id = useId();
  const [form, setForm] = useState(() => initialForm(graph));
  const [error, setError] = useState<string>();
  const validation = useFieldValidation<string>();
  function change(next: typeof form) {
    setForm(next);
    setError(undefined);
    validation.reset();
    onChange();
  }
  return (
    <form
      noValidate
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!editable) return;
        const { callable: _callable, ...ordinaryGraph } = graph;
        let candidate: unknown = ordinaryGraph;
        if (form.enabled) {
          try {
            candidate = {
              ...graph,
              callable: {
                input: declaredType(form.input),
                resultType: declaredType(form.resultType),
                result: declaredResult(form.result),
              },
            };
          } catch {
            const message = 'Result JSON must be valid JSON.';
            setError(message);
            validation.submit({ 'callable.result.json': message });
            return;
          }
        }
        const parsed = safeParseWorkflowGraphDraft(candidate);
        if (!parsed.success) {
          const fields: Record<string, string> = {};
          if ('issues' in parsed.error) {
            for (const issue of parsed.error.issues) {
              const path = issue.path.map(String).join('.');
              fields[path] = path.endsWith('.name')
                ? 'Fill in the property name.'
                : path.endsWith('.maxItems')
                  ? 'Enter a whole-number array limit from 0 to 10,000.'
                  : issue.message;
            }
          }
          setError('Check the highlighted contract fields before applying.');
          validation.submit(fields);
          return;
        }
        const issue = validateWorkflowGraph(parsed.data).issues.find((item) =>
          item.path.startsWith('$.callable'),
        );
        if (issue !== undefined) {
          setError(issue.message);
          validation.submit({
            [issue.path.slice(2).replace(/\[(\d+)\]/gu, '.$1')]: issue.message,
          });
          return;
        }
        onApply(parsed.data);
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6">
        <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-5">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <Checkbox
              checked={form.enabled}
              onCheckedChange={(enabled) => {
                change({ ...form, enabled });
              }}
            />
            Declare a callable contract
          </label>
          {form.enabled ? (
            <>
              <p className="text-sm text-muted-foreground">
                Use one enabled Manual or Webhook entry. Inputs and results stay
                inline; no extra properties, coercion or inserted defaults.
              </p>
              <div className="grid min-w-0 gap-6 sm:grid-cols-2">
                <fieldset className="min-w-0">
                  <legend className="mb-3 text-sm font-semibold">
                    Accepted input
                  </legend>
                  <TypeFields
                    value={form.input}
                    path="callable.input"
                    validation={validation}
                    onChange={(input) => {
                      change({ ...form, input });
                    }}
                  />
                </fieldset>
                <fieldset className="min-w-0">
                  <legend className="mb-3 text-sm font-semibold">
                    Returned value
                  </legend>
                  <TypeFields
                    value={form.resultType}
                    path="callable.resultType"
                    validation={validation}
                    onChange={(resultType) => {
                      change({ ...form, resultType });
                    }}
                  />
                </fieldset>
              </div>
              <Separator />
              <FieldGroup>
                <ResultFields
                  graph={graph}
                  validation={validation}
                  value={form.result}
                  onChange={(result) => {
                    change({ ...form, result });
                  }}
                />
              </FieldGroup>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              This workflow accepts its ordinary trigger input and has no
              declared result.
            </p>
          )}
        </fieldset>
      </div>
      {error === undefined ? null : (
        <Notice id={`${id}-error`} tone="destructive" className="mx-6 shrink-0">
          {error}
        </Notice>
      )}
      <div className="flex shrink-0 flex-wrap justify-end gap-2 px-6 pb-6">
        <Button type="button" variant="ghost" onClick={onClose}>
          {editable ? 'Cancel' : 'Close'}
        </Button>
        {editable ? (
          <Button
            type="submit"
            variant="primary"
            aria-describedby={error === undefined ? undefined : `${id}-error`}
          >
            Apply contract
          </Button>
        ) : null}
      </div>
    </form>
  );
}
