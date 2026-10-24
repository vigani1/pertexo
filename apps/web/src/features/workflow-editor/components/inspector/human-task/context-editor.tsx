import { ContextFieldRow } from './context-row';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { VariablesScope } from '@/features/workspace-variables/picker.public';
import jsonata from 'jsonata';
import {
  canonicalJson,
  taskDetailsSchema,
  parseTaskPrefill,
  type FormField,
  type ValueSource,
} from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import {
  contextRows,
  contextMapping,
} from '../../../model/inspector/object-mappings/rows';
import {
  validateInputMappingRows,
  type InputMappingDraftRow,
} from '../../../model/inspector/input-mappings/draft';
import { useInspectorDraftField } from '../use-draft-field';

type Props = Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  variableScope: VariablesScope;
  node: WorkflowNode;
  graph: GraphLevel;
  form: NodeFormApi;
  group: 'details' | 'prefill';
  fields?: readonly FormField[];
}>;
export function TaskContextEditor(props: Props) {
  const source = props.node.inputMappings[props.group];
  const rows = contextRows(source);
  if (rows === undefined)
    return (
      <Notice>
        This {props.group} mapping reads a whole object. Edit it in Inputs; its
        saved mapping is preserved.
      </Notice>
    );
  return <ContextFields {...props} source={source} initialRows={rows} />;
}
function ContextFields({
  node,
  graph,
  form,
  group,
  fields,
  source,
  initialRows,
  definitions,
  variableScope,
}: Props &
  Readonly<{
    source: ValueSource | undefined;
    initialRows: readonly InputMappingDraftRow[];
  }>) {
  const draft = useInspectorDraftField<
    ValueSource | undefined,
    readonly InputMappingDraftRow[]
  >({
    value: source,
    format: () => initialRows,
    equals: (left, right) =>
      canonicalJson(left ?? null) === canonicalJson(right ?? null),
    parse: (rows) => {
      if (
        rows.length > 20 ||
        rows.some((row) => row.destinationKey.length > 160)
      )
        return {
          ok: false,
          error: 'Use up to 20 fields with names up to 160 characters.',
        };
      if (
        group === 'prefill' &&
        rows.some(
          (row) => !fields?.some((field) => field.name === row.destinationKey),
        )
      )
        return { ok: false, error: 'Choose a field from this request.' };
      const checked = validateInputMappingRows(rows, graph, node.id, {
        checkGraph: false,
      });
      if (checked.inputMappings === undefined)
        return {
          ok: false,
          error:
            'Give each field a unique label and complete its value or mapping.',
        };
      const mapping = contextMapping(checked.inputMappings);
      if (mapping === undefined)
        return {
          ok: false,
          error:
            'Use a value, run input, earlier step output, variable or expression.',
        };
      try {
        if (mapping.kind === 'expression') {
          if (new TextEncoder().encode(mapping.expression).length > 16384)
            return { ok: false, error: 'Keep these mappings within 16 KB.' };
          jsonata(mapping.expression);
        } else if (mapping.kind === 'literal') {
          if (group === 'details') taskDetailsSchema.parse(mapping.value);
          else parseTaskPrefill(fields ?? [], mapping.value);
        }
        return { ok: true, value: mapping };
      } catch {
        return {
          ok: false,
          error:
            group === 'details'
              ? 'Use plain details or lists of up to 20 plain values within 8 KB, with complete expressions.'
              : 'Check prefill types, choices, selection limits and expressions.',
        };
      }
    },
    commit: (mapping) => {
      form.commit(
        (current) => ({
          inputMappings: {
            ...current.inputMappings,
            ...(mapping === undefined ? {} : { [group]: mapping }),
          },
        }),
        `${node.id}:task:${group}`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch(`task-context-${group}`, scratch);
    },
  });
  const available =
    fields?.filter(
      (field) => !draft.text.some((row) => row.destinationKey === field.name),
    ) ?? [];
  function replace(row: InputMappingDraftRow) {
    draft.change(
      draft.text.map((current) => (current.id === row.id ? row : current)),
    );
  }
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3"
      onBlurCapture={draft.blur}
      disabled={!form.editable}
    >
      <legend className="mb-3 font-medium">
        {group === 'details'
          ? 'Details for the person responding'
          : 'Prefill fields'}
      </legend>
      {draft.text.map((row) => {
        return (
          <ContextFieldRow
            key={row.id}
            row={row}
            group={group}
            fields={fields}
            graph={graph}
            form={form}
            definitions={definitions}
            variableScope={variableScope}
            onChange={replace}
            onRemove={() => {
              draft.change(draft.text.filter((item) => item.id !== row.id));
            }}
          />
        );
      })}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={
          !form.editable ||
          draft.text.length >= 20 ||
          (group === 'prefill' && available.length === 0)
        }
        onClick={() => {
          draft.change([
            ...draft.text,
            {
              id: crypto.randomUUID(),
              destinationKey:
                group === 'prefill' ? (available[0]?.name ?? '') : '',
              kind: 'literal',
              literalJson:
                group === 'prefill' ? defaultPrefill(available[0]) : '""',
            },
          ]);
        }}
      >
        Add {group === 'details' ? 'detail' : 'prefill'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Values are saved once when the task opens.
        {group === 'prefill'
          ? ' The person can edit them before responding.'
          : ' Up to 20 details within 8 KB; each list has up to 20 plain values.'}
      </p>
      {draft.error === undefined ? null : (
        <Notice tone="destructive">{draft.error}</Notice>
      )}
    </fieldset>
  );
}

function defaultPrefill(field: FormField | undefined): string {
  if (field?.type === 'number') {
    return '0';
  }
  if (field?.type === 'boolean') {
    return 'false';
  }
  if (field?.type === 'multi_select') {
    return '[]';
  }
  return '""';
}
