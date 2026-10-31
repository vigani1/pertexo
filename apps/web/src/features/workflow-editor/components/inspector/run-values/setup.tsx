import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import {
  RUN_VALUE_LIMITS,
  runValueKeySchema,
  runValueTextSchema,
  saveRunValuesInputSchema,
} from '@pertexo/node-sdk';
import { canonicalJson, type ValueSource } from '@pertexo/workflow-model';
import jsonata from 'jsonata';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
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
import { RunValueRow } from './row';
type Props = Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  definitions: readonly NodeDefinitionCatalogItem[];
  form: NodeFormApi;
  variableScope: WorkspaceApiScope | undefined;
}>;
export function RunValuesSetup(props: Props) {
  const source = props.node.inputMappings.values;
  const rows = contextRows(source);
  if (rows === undefined)
    return (
      <Notice>
        This step reads a whole values object. Edit its mapping in Inputs; the
        saved mapping is preserved.
      </Notice>
    );
  return <RunValueFields {...props} source={source} initialRows={rows} />;
}
function RunValueFields({
  node,
  graph,
  definitions,
  form,
  variableScope,
  source,
  initialRows,
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
    equals: (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null),
    parse: (rows) => {
      if (rows.length === 0 || rows.length > RUN_VALUE_LIMITS.pairs)
        return { ok: false, error: 'Add between one and ten run values.' };
      if (
        rows.some(
          (row) => !runValueKeySchema.safeParse(row.destinationKey).success,
        )
      )
        return {
          ok: false,
          error:
            'Use unique keys up to 50 letters, numbers, dots, hyphens or underscores. Start with a letter or number.',
        };
      for (const row of rows) {
        if (row.kind === 'literal') {
          try {
            runValueTextSchema.parse(JSON.parse(row.literalJson));
          } catch {
            return {
              ok: false,
              error:
                'Each value must be text up to 255 characters. Empty text is allowed.',
            };
          }
        }
      }
      const checked = validateInputMappingRows(rows, graph, node.id, {
        checkGraph: false,
      });
      const mapping =
        checked.inputMappings === undefined
          ? undefined
          : contextMapping(checked.inputMappings);
      if (mapping === undefined)
        return {
          ok: false,
          error: 'Complete each unique key and its value or mapping.',
        };
      try {
        if (mapping.kind === 'expression') jsonata(mapping.expression);
        else if (mapping.kind === 'literal')
          saveRunValuesInputSchema.parse({ values: mapping.value });
        return { ok: true, value: mapping };
      } catch {
        return {
          ok: false,
          error:
            'Complete each expression and use text values up to 255 characters.',
        };
      }
    },
    commit: (mapping) => {
      form.commit(
        (current) => ({
          inputMappings: {
            ...current.inputMappings,
            ...(mapping === undefined ? {} : { values: mapping }),
          },
        }),
        `${node.id}:run-values`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch('run-values', scratch);
    },
  });
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3"
      disabled={!form.editable}
      onBlurCapture={draft.blur}
    >
      <legend className="mb-3 font-medium">Save run values</legend>
      <p className="text-sm text-muted-foreground">
        Use business data, never secrets. Anyone who can read this run can see
        these values. Keep up to ten keys per run; saving a key again replaces
        its value.
      </p>
      {draft.text.map((row) => (
        <RunValueRow
          key={row.id}
          row={row}
          graph={graph}
          definitions={definitions}
          form={form}
          variableScope={variableScope}
          onChange={(next) => {
            draft.change(
              draft.text.map((current) =>
                current.id === next.id ? next : current,
              ),
            );
          }}
          onRemove={() => {
            draft.change(draft.text.filter((current) => current.id !== row.id));
          }}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={!form.editable || draft.text.length >= RUN_VALUE_LIMITS.pairs}
        onClick={() => {
          draft.change([
            ...draft.text,
            {
              id: crypto.randomUUID(),
              destinationKey: '',
              kind: 'literal',
              literalJson: '""',
            },
          ]);
        }}
      >
        Add run value
      </Button>
      <p className="text-xs text-muted-foreground">
        Keys: 50 characters. Text values: 255 characters. Mapped values are
        checked when the step runs.
      </p>
      {draft.error === undefined ? null : (
        <Notice tone="destructive">{draft.error}</Notice>
      )}
    </fieldset>
  );
}
