import { useInspectorSession } from '../use-session';
import { useState } from 'react';

import type { VariablesScope } from '@/features/workspace-variables/picker.public';
import type { FormField } from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import type { GraphLevel } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  directPredecessorOptions,
  type InputMappingDraftRow,
} from '../../../model/inspector/input-mappings/draft';
import type { SchemaValueType } from '../../../model/inspector/input-mappings/schema';
import { InsertDataPicker } from '../input-mappings/insert-data/picker';
import { MappingValueEditor } from '../input-mappings/value-editor';
import { ChoiceSelect } from '../fields/choice-select';

export function ContextFieldRow({
  row,
  group,
  fields,
  graph,
  form,
  variableScope,
  onChange,
  onRemove,
}: Readonly<{
  row: InputMappingDraftRow;
  group: 'details' | 'prefill';
  fields: readonly FormField[] | undefined;
  graph: GraphLevel;
  form: NodeFormApi;
  variableScope: VariablesScope;
  onChange: (row: InputMappingDraftRow) => void;
  onRemove: () => void;
}>) {
  const { definitions } = useInspectorSession();
  const field = fields?.find((item) => item.name === row.destinationKey);
  const storedType =
    row.kind === 'literal' ? literalType(row.literalJson) : undefined;
  const [valueType, setValueType] = useState(storedType);
  if (storedType !== undefined && storedType !== valueType)
    setValueType(storedType);
  const currentType = storedType ?? valueType;
  return (
    <section
      aria-label={
        group === 'details'
          ? 'Detail'
          : `Prefill ${field?.label ?? row.destinationKey}`
      }
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
    >
      <div className="flex items-end gap-2">
        <LabelledField
          id={`${form.nodeId}-${group}-${row.id}-label`}
          label={group === 'details' ? 'Label' : 'Field'}
        >
          {(control) =>
            group === 'details' ? (
              <Input
                {...control}
                maxLength={160}
                value={row.destinationKey}
                onChange={(event) => {
                  onChange({
                    ...row,
                    destinationKey: event.currentTarget.value,
                  });
                }}
              />
            ) : (
              <ChoiceSelect
                disabled={!form.editable}

                value={row.destinationKey}
                choices={(fields ?? []).map((item) => ({
                  value: item.name,
                  label: item.label,
                }))}
                onChange={(name) => {
                  if (name !== null) onChange({ ...row, destinationKey: name });
                }}
                control={{ id: control.id }}
              />
            )
          }
        </LabelledField>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${group === 'details' ? 'detail' : 'prefill'} ${row.destinationKey || 'field'}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      {group === 'details' && row.kind === 'literal' ? (
        <DetailType
          id={`${form.nodeId}-${row.id}-type`}
          disabled={!form.editable}
          value={currentType ?? 'null'}
          onChange={(literalJson) => {
            onChange({ ...row, literalJson });
          }}
        />
      ) : null}
      <InsertDataPicker
        graph={graph}
        variableScope={variableScope}
        nodeId={form.nodeId}
        loopPorts={[]}
        definitions={definitions}
        allowFailure={false}
        disabled={!form.editable}
        onInsert={(inserted) => {
          onChange({
            id: row.id,
            destinationKey: row.destinationKey,
            ...inserted,
          });
        }}
      />
      <MappingValueEditor
        row={row}

        type={
          field === undefined ? detailSchemaType(currentType) : fieldType(field)
        }
        error={undefined}
        disabled={!form.editable}
        allowedKinds={[
          'literal',
          'run_input',
          'node_output',
          'workspace_variable',
          'expression',
        ]}
        onChange={onChange}
        context={{
          nodeId: form.nodeId,
          graph: graph,
          predecessors: directPredecessorOptions(graph, form.nodeId),
          loopPorts: [],
        }}
      />
    </section>
  );
}

function literalType(
  text: string,
): 'null' | 'list' | 'string' | 'number' | 'boolean' | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'list';
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return typeof value as 'string' | 'number' | 'boolean';
    }
    return undefined;
  } catch {
    return undefined;
  }
}
function fieldType(field: FormField): SchemaValueType {
  if (field.type === 'number') {
    return 'number';
  }
  if (field.type === 'boolean') {
    return 'boolean';
  }
  if (field.type === 'multi_select') {
    return 'array';
  }
  return 'string';
}

const detailTypes = [
  { value: 'string', label: 'Text', literal: '""' },
  { value: 'number', label: 'Number', literal: '0' },
  { value: 'boolean', label: 'True or false', literal: 'false' },
  { value: 'null', label: 'Empty', literal: 'null' },
  { value: 'list', label: 'List of plain values', literal: '[]' },
] as const;
function DetailType({
  id,
  disabled,
  value,
  onChange,
}: Readonly<{
  id: string;
  disabled: boolean;
  value: string;
  onChange: (literalJson: string) => void;
}>) {
  return (
    <LabelledField id={id} label="Value type">
      {(control) => (
        <ChoiceSelect
          disabled={disabled}
          value={value}
          choices={detailTypes}
          onChange={(type) => {
            const choice = detailTypes.find((item) => item.value === type);
            if (choice !== undefined) onChange(choice.literal);
          }}
          control={{ id: control.id }}
        />
      )}
    </LabelledField>
  );
}
function detailSchemaType(
  type: ReturnType<typeof literalType>,
): SchemaValueType | undefined {
  if (type === 'list') return 'array';
  if (type === 'null') return undefined;
  return type;
}
