import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { formatByteSize } from '@pertexo/node-sdk';
import { QueryView } from '@/components/patterns/states/query-view';
import {
  WORKFLOW_TEST_LIMITS,
  workflowTestStepChoices,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { CaseExpectationDraft } from '../../model/input-cases/expectations';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { workflowShapeQueryOptions } from '../../data/workflows.queries';
export function CaseExpectations({
  value,
  onChange,
  disabled,
  scope,
  error,
  versionGraph,
  expectedColumns,
}: Readonly<{
  value: CaseExpectationDraft;
  onChange: (value: CaseExpectationDraft) => void;
  disabled: boolean;
  scope: {
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
    workflowId: string;
  };
  error: string | undefined;
  versionGraph?: WorkflowGraph | undefined;
  expectedColumns?: readonly Choice[] | undefined;
}>) {
  const graph = useQuery({
    ...workflowShapeQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      scope.workflowId,
    ),
    staleTime: QUERY_FRESHNESS.none,
    enabled: value.assertions.length > 0 && versionGraph === undefined,
  });
  const testedGraph = versionGraph ?? graph.data;
  const choices = [
    { value: '', label: 'Final output (declared result)' },
    ...(testedGraph === undefined
      ? []
      : workflowTestStepChoices(testedGraph).map((node) => ({
          value: node.nodeId,
          label: `${node.label} (${node.nodeId})`,
        }))),
  ];
  function update(
    id: string,
    change: Partial<CaseExpectationDraft['assertions'][number]>,
  ) {
    onChange({
      ...value,
      assertions: value.assertions.map((item) =>
        item.id === id ? { ...item, ...change } : item,
      ),
    });
  }
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <legend className="text-sm font-semibold">Test expectations</legend>
      <p className="text-xs text-muted-foreground">
        No value checks are required. Final output needs a declared workflow
        result; otherwise choose a step. A chosen step must run once; use a
        downstream summary for loops. Expected values are JSON, up to{' '}
        {formatByteSize(WORKFLOW_TEST_LIMITS.expectedValueBytes)} each.
      </p>
      <LabelledField id="case-outcome" label="Expected outcome">
        {(control) => (
          <Select
            value={value.outcome}
            onValueChange={(outcome) => {
              if (outcome !== null) onChange({ ...value, outcome });
            }}
            items={[
              { value: 'succeeds', label: 'Succeeds' },
              { value: 'fails', label: 'Fails' },
            ]}
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="succeeds">Succeeds</SelectItem>
              <SelectItem value="fails">Fails</SelectItem>
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {versionGraph === undefined ? (
        <QueryView query={graph} resource="Step choices" loading={null} />
      ) : null}
      {value.assertions.map((item, index) => (
        <ExpectationRow
          key={item.id}
          item={item}
          index={index}
          choices={choices}
          expectedColumns={expectedColumns}
          onChange={(change) => {
            update(item.id, change);
          }}
          onRemove={() => {
            onChange({
              ...value,
              assertions: value.assertions.filter(
                (entry) => entry.id !== item.id,
              ),
            });
          }}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={
          disabled || value.assertions.length >= WORKFLOW_TEST_LIMITS.assertions
        }
        onClick={() => {
          onChange({
            ...value,
            assertions: [
              ...value.assertions,
              {
                id: crypto.randomUUID(),
                source: '',
                path: '$',
                operator: 'equals',
                expected: 'null',
              },
            ],
          });
        }}
      >
        Add value check
      </Button>
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

type Choice = Readonly<{ value: string; label: string }>;
type ExpectationRowProps = Readonly<{
  item: CaseExpectationDraft['assertions'][number];
  index: number;
  choices: readonly Choice[];
  expectedColumns: readonly Choice[] | undefined;
  onChange: (
    change: Partial<CaseExpectationDraft['assertions'][number]>,
  ) => void;
  onRemove: () => void;
}>;
function ExpectationRow({
  item,
  index,
  choices,
  expectedColumns,
  onChange,
  onRemove,
}: ExpectationRowProps) {
  return (
    <fieldset className="min-w-0 space-y-2 rounded-md border p-3">
      <legend className="text-xs">Check {index + 1}</legend>
      <LabelledField id={`${item.id}-source`} label="Output">
        {(control) => (
          <Select
            value={item.source}
            items={
              choices.some((choice) => choice.value === item.source)
                ? choices
                : [
                    ...choices,
                    {
                      value: item.source,
                      label: `Missing step (${item.source})`,
                    },
                  ]
            }
            onValueChange={(source) => {
              if (source !== null) onChange({ source });
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
              {item.source !== '' &&
              !choices.some((choice) => choice.value === item.source) ? (
                <SelectItem value={item.source}>
                  Missing step ({item.source})
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {expectedColumns !== undefined && item.source !== '' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={item.path === '$.selectedPort'}
          onClick={() => {
            onChange({ path: '$.selectedPort', operator: 'equals' });
          }}
        >
          Use selected branch
        </Button>
      ) : null}
      <LabelledField id={`${item.id}-path`} label="JSON path">
        {(control) => (
          <Input
            {...control}
            value={item.path}
            maxLength={WORKFLOW_TEST_LIMITS.pathLength}
            placeholder="$.total"
            autoComplete="off"
            onChange={(event) => {
              onChange({ path: event.target.value });
            }}
          />
        )}
      </LabelledField>
      <LabelledField id={`${item.id}-operator`} label="Compare">
        {(control) => (
          <Select
            value={item.operator}
            items={[
              { value: 'equals', label: 'Equals' },
              { value: 'contains', label: 'Contains' },
            ]}
            onValueChange={(operator) => {
              if (operator !== null) onChange({ operator });
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="equals">Equals</SelectItem>
              <SelectItem value="contains">Contains</SelectItem>
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {expectedColumns === undefined ? null : (
        <ExpectedValueSource
          id={item.id}
          value={item.expectedColumn}
          expectedColumns={expectedColumns}
          onChange={(expectedColumn) => {
            onChange({ expectedColumn });
          }}
        />
      )}
      {item.expectedColumn === undefined ? (
        <LabelledField id={`${item.id}-expected`} label="Expected value (JSON)">
          {(control) => (
            <Textarea
              {...control}
              value={item.expected}
              autoComplete="off"
              spellCheck={false}
              typography="mono"
              className="min-h-16"
              onChange={(event) => {
                onChange({ expected: event.target.value });
              }}
            />
          )}
        </LabelledField>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          onRemove();
        }}
      >
        Remove check {index + 1}
      </Button>
    </fieldset>
  );
}

function ExpectedValueSource({
  id,
  value,
  expectedColumns,
  onChange,
}: Readonly<{
  id: string;
  value: string | undefined;
  expectedColumns: readonly Choice[];
  onChange: (column: string | undefined) => void;
}>) {
  return (
    <LabelledField id={`${id}-expected-source`} label="Expected value source">
      {(control) => (
        <Select
          value={value ?? ''}
          onValueChange={(column) => {
            onChange(column === '' ? undefined : (column ?? undefined));
          }}
          items={[{ value: '', label: 'Fixed value' }, ...expectedColumns]}
        >
          <SelectTrigger {...control}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Fixed value</SelectItem>
            {expectedColumns.map(({ value, label }) => (
              <SelectItem value={value} key={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </LabelledField>
  );
}
