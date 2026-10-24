import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { GraphLevel } from '../../../model/graph/scopes';
import {
  changeInputMappingKind,
  isEditableInputMappingKind,
  type EditableInputMappingKind,
  type InputMappingDraftRow,
  type PredecessorOption,
} from '../../../model/inspector/input-mappings/draft';
import type { SchemaValueType } from '../../../model/inspector/input-mappings/schema';
import { MappingSourceEditor } from './mapping-source-editor';

type KindOption = Readonly<{ kind: EditableInputMappingKind; label: string }>;

const kinds: readonly KindOption[] = [
  { kind: 'workspace_variable', label: 'Variable' },
  { kind: 'literal', label: 'Value' },
  { kind: 'run_input', label: 'Run input' },
  { kind: 'node_output', label: 'Step output' },
  { kind: 'expression', label: 'Expression' },
];
/** Offered inside a For each body, or kept visible where one is stored. */
const loopItemKind: KindOption = {
  kind: 'structured_input',
  label: 'Loop item',
};

export type MappingSources = Readonly<{
  nodeId: string;
  graph: GraphLevel;
  predecessors: readonly PredecessorOption[];
  loopPorts: readonly string[];
}>;

export function MappingValueEditor({
  row,
  type,
  error,
  disabled,
  onChange,
  allowedKinds,
  context,
}: Readonly<{
  allowedKinds?: readonly EditableInputMappingKind[];
  row: InputMappingDraftRow;
  type: SchemaValueType | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
  context: MappingSources;
}>) {
  const { nodeId, graph, predecessors, loopPorts } = context;

  const failureSource = graph.edges.find(
    (edge) =>
      edge.target.nodeId === nodeId &&
      edge.source.port === WORKFLOW_FAILURE_PORT,
  )?.source.nodeId;
  const failureKind: KindOption = { kind: 'node_failure', label: 'Failure' };
  const baseKinds =
    failureSource !== undefined || row.kind === 'node_failure'
      ? [...kinds, failureKind]
      : kinds;
  const options =
    loopPorts.length > 0 || row.kind === 'structured_input'
      ? [...baseKinds, loopItemKind]
      : baseKinds;
  const permittedKinds =
    allowedKinds === undefined ? undefined : new Set(allowedKinds);
  return (
    <>
      <ToggleGroup
        aria-label="Source"
        value={[row.kind]}
        disabled={disabled}
        // Wrap source choices within the inspector rather than narrowing the labels.
        className="w-full flex-wrap [&>*]:flex-1 [&>*]:px-1.5 [&>*]:text-[0.78rem]"
        onValueChange={(values) => {
          const kind: unknown = values[0];
          if (!isEditableInputMappingKind(kind)) return;
          onChange(
            changeInputMappingKind(
              row,
              kind,
              kind === 'node_failure' ? failureSource : predecessors[0]?.nodeId,
            ),
          );
        }}
      >
        {options
          .filter(
            (option) =>
              permittedKinds === undefined || permittedKinds.has(option.kind),
          )
          .map((option) => (
            <ToggleGroupItem key={option.kind} value={option.kind}>
              {option.label}
            </ToggleGroupItem>
          ))}
      </ToggleGroup>
      <MappingSourceEditor
        nodeId={nodeId}
        row={row}
        type={type}
        predecessors={predecessors}
        loopPorts={loopPorts}
        error={error}
        disabled={disabled}
        onChange={onChange}
      />
    </>
  );
}
