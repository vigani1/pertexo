import { formatByteSize } from '@pertexo/node-sdk';
import { formatCount } from '@/lib/format/count';
import { ContextFieldRow } from './context-row';

import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import jsonata from 'jsonata';
import {
  canonicalJson,
  EXPRESSION_BYTES_MAX,
  PENDING_TASK_LIMITS,
  taskDetailsSchema,
  parseTaskPrefill,
  type FormField,
  type ValueSource,
} from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
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
import { useInspectorDraftField } from '../../../hooks/inspector/use-draft-field';

type Props = Readonly<{
  variableScope: WorkspaceApiScope;
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
type ContextFieldsProps = Props &
  Readonly<{
    source: ValueSource | undefined;
    initialRows: readonly InputMappingDraftRow[];
  }>;

function ContextFields(props: ContextFieldsProps) {
  const model = useContextMappings(props);
  const addingContextBlocked =
    !model.form.editable ||
    model.draft.text.length >= PENDING_TASK_LIMITS.detailFields ||
    (model.group === 'prefill' && model.available.length === 0);
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3"
      onBlurCapture={model.draft.blur}
      disabled={!model.form.editable}
    >
      <legend className="mb-3 font-medium">
        {model.group === 'details'
          ? 'Details for the person responding'
          : 'Prefill fields'}
      </legend>
      {model.group === 'details' && model.draft.text.length === 0 ? (
        <Notice tone="warning">
          The person responding will see only the title. Add what they need to
          decide, such as a value from the trigger.
        </Notice>
      ) : null}
      {model.draft.text.map((row) => {
        return (
          <ContextFieldRow
            key={row.id}
            row={row}
            group={model.group}
            fields={model.fields}
            graph={model.graph}
            form={model.form}
            variableScope={model.variableScope}
            onChange={model.replace}
            onRemove={() => {
              model.draft.change(
                model.draft.text.filter((item) => item.id !== row.id),
              );
            }}
          />
        );
      })}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={addingContextBlocked}
        onClick={() => {
          model.draft.change([
            ...model.draft.text,
            {
              id: crypto.randomUUID(),
              destinationKey:
                model.group === 'prefill'
                  ? (model.available[0]?.name ?? '')
                  : '',
              kind: 'literal',
              literalJson:
                model.group === 'prefill'
                  ? defaultPrefill(model.available[0])
                  : '""',
            },
          ]);
        }}
      >
        Add {model.group === 'details' ? 'detail' : 'prefill'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Values are saved once when the task opens.
        {model.group === 'prefill'
          ? ' The person can edit them before responding.'
          : ` Up to ${formatCount(PENDING_TASK_LIMITS.detailFields, 'detail')} within ${formatByteSize(PENDING_TASK_LIMITS.detailsBytes)}; each list has up to ${formatCount(PENDING_TASK_LIMITS.detailListItems, 'plain value')}.`}
      </p>
      {model.draft.error === undefined ? null : (
        <Notice tone="destructive">{model.draft.error}</Notice>
      )}
    </fieldset>
  );
}

function useContextMappings({
  node,
  graph,
  form,
  group,
  fields,
  source,
  initialRows,
  variableScope,
}: ContextFieldsProps) {
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
        rows.length > PENDING_TASK_LIMITS.detailFields ||
        rows.some(
          (row) =>
            row.destinationKey.length >
            PENDING_TASK_LIMITS.detailNameCharacters,
        )
      )
        return {
          ok: false,
          error: `Use up to ${formatCount(PENDING_TASK_LIMITS.detailFields, 'field')} with names up to ${formatCount(PENDING_TASK_LIMITS.detailNameCharacters, 'character')}.`,
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
      if (checked.inputMappings === undefined) {
        const unnamed = rows.findIndex(
          (row) => row.destinationKey.trim() === '',
        );
        return {
          ok: false,
          error:
            unnamed === -1
              ? 'Give each field a unique label and complete its value or mapping.'
              : `Field ${String(unnamed + 1)} needs a label.`,
        };
      }
      const mapping = contextMapping(checked.inputMappings);
      if (mapping === undefined)
        return {
          ok: false,
          error:
            'Use a value, run input, earlier step output, variable or expression.',
        };
      try {
        if (mapping.kind === 'expression') {
          if (
            new TextEncoder().encode(mapping.expression).length >
            EXPRESSION_BYTES_MAX
          )
            return {
              ok: false,
              error: `Keep these mappings within ${formatByteSize(EXPRESSION_BYTES_MAX)}.`,
            };
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
              ? `Use plain details or lists of up to ${formatCount(PENDING_TASK_LIMITS.detailListItems, 'plain value')} within ${formatByteSize(PENDING_TASK_LIMITS.detailsBytes)}, with complete expressions.`
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

  return {
    draft,
    form,
    group,
    fields,
    graph,
    variableScope,
    replace,
    available,
  } as const;
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
