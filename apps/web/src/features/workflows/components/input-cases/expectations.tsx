import { QueryView } from '@/components/patterns/states/query-view';
import { workflowTestStepChoices } from '@pertexo/workflow-model';
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
}>) {
  const graph = useQuery({
    ...workflowShapeQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      scope.workflowId,
    ),
    staleTime: 0,
    enabled: value.assertions.length > 0,
  });
  const choices = [
    { value: '', label: 'Final output (declared result)' },
    ...(graph.data === undefined
      ? []
      : workflowTestStepChoices(graph.data).map((node) => ({
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
        downstream summary for loops. Expected values are JSON, up to 4 KB each.
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
      <QueryView query={graph} resource="Step choices" loading={null} />
      {value.assertions.map((item, index) => (
        <ExpectationRow
          key={item.id}
          item={item}
          index={index}
          choices={choices}
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
        disabled={disabled || value.assertions.length >= 20}
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

type ExpectationRowProps = Readonly<{
  item: CaseExpectationDraft['assertions'][number];
  index: number;
  choices: readonly Readonly<{ value: string; label: string }>[];
  onChange: (
    change: Partial<CaseExpectationDraft['assertions'][number]>,
  ) => void;
  onRemove: () => void;
}>;
function ExpectationRow({
  item,
  index,
  choices,
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
      <LabelledField id={`${item.id}-path`} label="JSON path">
        {(control) => (
          <Input
            {...control}
            value={item.path}
            maxLength={512}
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
      <LabelledField id={`${item.id}-expected`} label="Expected value (JSON)">
        {(control) => (
          <Textarea
            {...control}
            value={item.expected}
            autoComplete="off"
            spellCheck={false}
            className="min-h-16 font-mono"
            onChange={(event) => {
              onChange({ expected: event.target.value });
            }}
          />
        )}
      </LabelledField>
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
