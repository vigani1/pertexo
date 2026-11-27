import { useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  workflowTableEvaluationSchema,
  type WorkflowVersionsResponse,
} from '@pertexo/contracts';
import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  WORKFLOW_TEST_SUITE_MAX_CASES,
} from '@pertexo/workflow-model';
import { tablesQuery } from '@/features/data-tables/public';
import {
  expectationDraft,
  evaluationExpectationRequest,
} from '@/features/workflows/public';
import { CaseExpectations } from '@/features/workflows/workflows-views.public';
import { QueryView } from '@/components/patterns/states/query-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/patterns/notices/inline-notice';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TestSuites } from '../../data/test-suites/workflow-test-suites.mutations';
import { evaluationVersionsQuery } from '../../data/test-suites/evaluation-versions.queries';

export function EvaluationSetup({
  suites,
  locked,
}: Readonly<{ suites: TestSuites; locked: boolean }>) {
  const versions = useQuery(evaluationVersionsQuery(suites.scope));
  const tables = useQuery(tablesQuery(suites.scope));
  const [tableId, setTableId] = useState<string>();
  const [versionId, setVersionId] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [expectations, setExpectations] = useState(() =>
    expectationDraft(undefined),
  );
  const [error, setError] = useState<string>();
  const table = tables.data?.tables.find(({ id }) => id === tableId);
  const version = versions.data?.items.find(({ id }) => id === versionId);
  const choices =
    table?.columns.map(({ id, name }) => ({ label: name, value: id })) ?? [];
  const mapped = Object.entries(fields).filter(
    ([, name]) => name.trim() !== '',
  );

  async function start() {
    if (table === undefined) return;
    const columns = Object.fromEntries(
      mapped.map(([id, name]) => [name.trim(), id]),
    );
    if (Object.keys(columns).length !== mapped.length) {
      setError('Map each input field once.');
      return;
    }
    let expected;
    try {
      expected = evaluationExpectationRequest(expectations);
    } catch {
      setError('Enter valid JSON for each fixed expected value.');
      return;
    }
    const evaluation = workflowTableEvaluationSchema.safeParse({
      tableId: table.id,
      ...(version === undefined ? {} : { versionId: version.id }),
      columns,
      expectations: expected,
    });
    if (!evaluation.success) {
      setError(
        evaluation.error.issues[0]?.message ?? 'Review the evaluation setup.',
      );
      return;
    }
    setError(undefined);
    await suites.submit({
      acknowledgeSideEffects: false,
      evaluation: evaluation.data,
    });
  }

  return (
    <fieldset disabled={locked} className="min-w-0 space-y-4">
      <legend className="sr-only">Evaluation setup</legend>
      <EvaluationVersionField
        versions={versions}
        value={versionId ?? ''}
        onChange={(id) => {
          setVersionId(id ?? undefined);
        }}
      />
      <QueryView
        query={tables}
        resource="Data tables"
        isEmpty={(value) => value.tables.length === 0}
        empty={
          <p className="text-sm text-muted-foreground">
            Create a workspace data table to add evaluation cases.
          </p>
        }
      >
        {({ tables: available }) => (
          <ChoiceField
            id="evaluation-table"
            label="Case table"
            value={tableId ?? null}
            choices={available.map(({ id, name }) => ({
              value: id,
              label: name,
            }))}
            onChange={(id) => {
              setTableId(id ?? undefined);
              setFields({});
              setExpectations((current) => ({
                ...current,
                assertions: current.assertions.map((item) => ({
                  ...item,
                  expectedColumn: undefined,
                })),
              }));
            }}
          />
        )}
      </QueryView>
      {table === undefined ? null : (
        <>
          <MappedInputFields
            columns={choices}
            fields={fields}
            onChange={(id, field) => {
              setFields((current) => ({ ...current, [id]: field }));
            }}
          />
          <CaseExpectations
            scope={suites.scope}
            value={expectations}
            onChange={setExpectations}
            disabled={locked}
            error={undefined}
            versionGraph={version?.graph}
            expectedColumns={choices}
          />
        </>
      )}
      {error === undefined ? null : <Notice tone="destructive">{error}</Notice>}
      {table !== undefined && table.rowCount > WORKFLOW_TEST_SUITE_MAX_CASES ? (
        <Notice tone="warning">
          Use a table with at most {WORKFLOW_TEST_SUITE_MAX_CASES} rows.
        </Notice>
      ) : null}
      <Button
        disabled={
          locked ||
          suites.preparation === undefined ||
          mapped.length === 0 ||
          table === undefined ||
          table.rowCount === 0 ||
          table.rowCount > WORKFLOW_TEST_SUITE_MAX_CASES
        }
        onClick={() => void start()}
      >
        {suites.start.pending ? 'Starting…' : 'Start evaluation'}
      </Button>
    </fieldset>
  );
}

type Choice = Readonly<{ value: string; label: string }>;

function EvaluationVersionField({
  versions,
  value,
  onChange,
}: Readonly<{
  versions: UseQueryResult<WorkflowVersionsResponse>;
  value: string;
  onChange: (value: string | null) => void;
}>) {
  return (
    <>
      <QueryView query={versions} resource="Workflow versions" loading={null} />
      <ChoiceField
        id="evaluation-version"
        label="Workflow version"
        value={value}
        onChange={onChange}
        choices={[
          { value: '', label: 'Saved draft' },
          ...(versions.data?.items.map(({ id, versionNumber }) => ({
            value: id,
            label: `Version ${String(versionNumber)}`,
          })) ?? []),
        ]}
      />
    </>
  );
}

function MappedInputFields({
  columns,
  fields,
  onChange,
}: Readonly<{
  columns: readonly Choice[];
  fields: Readonly<Record<string, string>>;
  onChange: (id: string, field: string) => void;
}>) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">
        Map columns to workflow inputs
      </legend>
      <p className="text-xs text-muted-foreground">
        Enter an input field beside each column you want to pass to the
        workflow.
      </p>
      {columns.map(({ value: id, label: name }) => (
        <LabelledField key={id} id={`evaluation-input-${id}`} label={name}>
          {(control) => (
            <Input
              {...control}
              value={fields[id] ?? ''}
              placeholder="Workflow input field"
              maxLength={WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength}
              onChange={(event) => {
                const field = event.target.value;
                onChange(id, field);
              }}
            />
          )}
        </LabelledField>
      ))}
    </fieldset>
  );
}

function ChoiceField({
  id,
  label,
  value,
  choices,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: string | null;
  choices: readonly Choice[];
  onChange: (value: string | null) => void;
}>) {
  return (
    <LabelledField id={id} label={label}>
      {(control) => (
        <Select value={value} items={choices} onValueChange={onChange}>
          <SelectTrigger {...control}>
            <SelectValue placeholder={label} />
          </SelectTrigger>
          <SelectContent>
            {choices.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </LabelledField>
  );
}
