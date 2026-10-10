import { useId } from 'react';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  emptyResult,
  type ResultDraft,
} from '../../forms/callable/result-draft';
import { indexGraph } from '../../model/graph/scopes';
import { ChoiceSelect } from '../inspector/fields/choice-select';

const SOURCES = [
  { value: 'run_input', label: 'Run input' },
  { value: 'node_output', label: 'Step output' },
  { value: 'literal', label: 'Literal JSON' },
  { value: 'expression', label: 'Expression' },
] as const;

export function ResultFields({
  value,
  graph,
  onChange,
  validation,
}: Readonly<{
  value: ResultDraft;
  graph: WorkflowGraphContract;
  onChange: (value: ResultDraft) => void;
  validation: FieldValidation<string>;
}>) {
  const id = useId();
  const steps = [...indexGraph(graph).nodes.values()].map(({ item }) => ({
    value: item.id,
    label: item.label ?? item.id,
  }));
  return (
    <FieldGroup className="gap-3">
      <LabelledField
        id={`${id}-source`}
        label="Result source"
        error={validation.error('callable.result.kind')}
      >
        {(control) => (
          <ChoiceSelect
            id={control.id}
            value={value.kind}
            choices={SOURCES}
            disabled={false}
            name="callable.result.kind"
            ref={validation.register('callable.result.kind')}
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            onChange={(next) => {
              const choice = SOURCES.find((entry) => entry.value === next);
              if (choice !== undefined && choice.value !== value.kind)
                onChange(emptyResult(choice.value));
            }}
          />
        )}
      </LabelledField>
      {value.kind === 'node_output' ? (
        <LabelledField
          id={`${id}-step`}
          label="Result step"
          error={validation.error('callable.result.nodeId')}
          description="Exactly one invocation of this step must succeed. Repeated loop outputs are ambiguous."
        >
          {(control) => (
            <ChoiceSelect
              id={control.id}
              value={value.nodeId || null}
              choices={[{ value: null, label: 'Choose a step' }, ...steps]}
              disabled={false}
              name="callable.result.nodeId"
              ref={validation.register('callable.result.nodeId')}
              invalid={control['aria-invalid']}
              describedBy={control['aria-describedby']}
              onChange={(nodeId) => {
                onChange({ ...value, nodeId: nodeId ?? '' });
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {value.kind === 'run_input' || value.kind === 'node_output' ? (
        <LabelledField
          id={`${id}-path`}
          label="Result path"
          error={validation.error('callable.result.path')}
          description="Use $ for the whole value, or a path such as $.customer.name."
        >
          {(control) => (
            <Input
              {...control}
              name="callable.result.path"
              ref={validation.register('callable.result.path')}
              value={value.path}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                onChange({ ...value, path: event.target.value });
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {value.kind === 'literal' ? (
        <LabelledField
          id={`${id}-json`}
          label="Result JSON"
          error={validation.error('callable.result.json')}
        >
          {(control) => (
            <Textarea
              {...control}
              name="callable.result.json"
              ref={validation.register('callable.result.json')}
              rows={4}
              value={value.json}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                onChange({ ...value, json: event.target.value });
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {value.kind === 'expression' ? (
        <LabelledField
          id={`${id}-expression`}
          label="Result expression"
          error={validation.error('callable.result.expression')}
          description="Restricted JSONata can read runInput and unique successful nodeOutputs. Publish checks the expression."
        >
          {(control) => (
            <Textarea
              {...control}
              name="callable.result.expression"
              ref={validation.register('callable.result.expression')}
              rows={4}
              value={value.expression}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                onChange({ ...value, expression: event.target.value });
              }}
            />
          )}
        </LabelledField>
      ) : null}
    </FieldGroup>
  );
}
