import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { VariablesScope } from '@/features/workspace-variables/picker.public';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import type { GraphLevel } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  directPredecessorOptions,
  type InputMappingDraftRow,
} from '../../../model/inspector/input-mappings/draft';
import { MappingValueEditor } from '../input-mappings/value-editor';
import { InsertDataPicker } from '../input-mappings/insert-data/picker';
export function RunValueRow({
  row,
  graph,
  definitions,
  form,
  variableScope,
  onChange,
  onRemove,
}: Readonly<{
  row: InputMappingDraftRow;
  graph: GraphLevel;
  definitions: readonly NodeDefinitionCatalogItem[];
  form: NodeFormApi;
  variableScope: VariablesScope | undefined;
  onChange: (row: InputMappingDraftRow) => void;
  onRemove: () => void;
}>) {
  return (
    <section
      aria-label="Run value"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
    >
      <div className="flex items-end gap-2">
        <LabelledField id={`${form.nodeId}-${row.id}-key`} label="Key">
          {(control) => (
            <Input
              {...control}
              maxLength={50}
              value={row.destinationKey}
              onChange={(event) => {
                onChange({ ...row, destinationKey: event.currentTarget.value });
              }}
            />
          )}
        </LabelledField>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove run value ${row.destinationKey || 'field'}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <InsertDataPicker
        graph={graph}
        nodeId={form.nodeId}
        loopPorts={[]}
        definitions={definitions}
        disabled={!form.editable}
        allowFailure={false}
        {...(variableScope === undefined ? {} : { variableScope })}
        onInsert={(source) => {
          onChange({
            id: row.id,
            destinationKey: row.destinationKey,
            ...source,
          });
        }}
      />
      <MappingValueEditor
        row={row}

        type="string"
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
